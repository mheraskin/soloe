import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type {
  DeviceCommandEnvelope,
  DeviceOperationReceipt
} from '@shared/types/commands.js';
import { isDeviceId } from '@shared/types/devices.js';
import type {
  CheckoutRecord,
  CheckoutLifecycleResult,
  CheckoutLossReport,
  CleanupIsolatedCheckoutIntent,
  CloneProjectPresenceIntent,
  ClonedProjectPresenceResult,
  DeviceWorkspaceIntent,
  DeviceWorkspacePlan,
  FastForwardedWorkspaceBranchResult,
  FetchFastForwardWorkspaceBranchIntent,
  PrepareWorkspaceLocationIntent,
  PrepareIsolatedSessionSourceIntent,
  PreparedWorkspaceLocationResult,
  PromoteIsolatedCheckoutIntent,
  PushedWorkspaceBranchResult,
  PublishNewRemoteBranchIntent,
  PushWorkspaceBranchIntent,
  WorkspaceSource
} from '@shared/types/workspaces.js';
import type { Session } from '@shared/types/sessions.js';
import type { GitWorkspaceWorktreeSource } from '@shared/types/git.js';
import type { GitService } from '../git/GitService.js';
import type { DeviceOperationStore } from './DeviceOperationStore.js';
import type { WorkspaceDeviceStore } from './WorkspaceDeviceStore.js';
import { CheckoutLossScanner } from './CheckoutLossScanner.js';

const DEFAULT_PLAN_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_PLANS = 1_000;

export interface WorkspaceDeviceServiceOptions {
  workspace: WorkspaceDeviceStore;
  operations: DeviceOperationStore;
  git: Pick<
    GitService,
    | 'getStatus'
    | 'listWorktrees'
    | 'addWorkspaceWorktree'
    | 'removeWorkspaceWorktree'
    | 'cloneRepository'
    | 'compareRevisions'
    | 'listLocalBranches'
    | 'scanCheckoutLoss'
    | 'inspectRemoteEvidence'
    | 'fetchRemoteEvidence'
    | 'pushBranch'
    | 'fastForwardBranch'
    | 'hasRemote'
    | 'publishNewRemoteBranch'
  >;
  /** Includes active and archived Sessions for ownership and consumer checks. */
  listSessions?: () => Promise<Session[]>;
  managedRoots: string[];
  capabilityRevision: string;
  now?: () => Date;
  planTtlMs?: number;
}

export class WorkspaceDeviceService {
  private readonly plans = new Map<string, DeviceWorkspacePlan>();
  private readonly managedRoots: string[];
  private readonly now: () => Date;
  private readonly planTtlMs: number;
  private readonly lossScanner: CheckoutLossScanner;

  constructor(private readonly options: WorkspaceDeviceServiceOptions) {
    this.managedRoots = options.managedRoots.map((root) => path.resolve(root));
    if (this.managedRoots.length === 0 || this.managedRoots.some((root) => !path.isAbsolute(root))) {
      throw new Error('Workspace Device Service requires at least one absolute managed root.');
    }
    if (!options.capabilityRevision.trim()) {
      throw new Error('Workspace Device Service capability revision is required.');
    }
    this.now = options.now ?? (() => new Date());
    this.planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
    if (!Number.isSafeInteger(this.planTtlMs) || this.planTtlMs < 1_000) {
      throw new Error('Workspace Device plan lifetime is invalid.');
    }
    this.lossScanner = new CheckoutLossScanner({
      workspace: options.workspace,
      git: options.git,
      listSessions: options.listSessions ?? (async () => [])
    });
  }

  async init(): Promise<void> {
    await Promise.all(this.managedRoots.map((root) => fs.mkdir(root, { recursive: true })));
  }

  async plan(intent: DeviceWorkspaceIntent): Promise<DeviceWorkspacePlan> {
    switch (intent.kind) {
      case 'prepare-workspace-location':
        return this.planWorkspaceLocation(intent);
      case 'clone-project-presence':
        return this.planCloneProjectPresence(intent);
      case 'prepare-isolated-session-source':
        return this.planIsolatedSessionSource(intent);
      case 'cleanup-isolated-checkout':
        return this.planCleanupIsolatedCheckout(intent);
      case 'promote-isolated-checkout':
        return this.planPromoteIsolatedCheckout(intent);
      case 'push-workspace-branch':
        return this.planPushWorkspaceBranch(intent);
      case 'fetch-fast-forward-workspace-branch':
        return this.planFetchFastForwardWorkspaceBranch(intent);
      case 'publish-new-remote-branch':
        return this.planPublishNewRemoteBranch(intent);
      default:
        throw new Error('Workspace Device planning intent is unsupported.');
    }
  }

  async execute(
    command: DeviceCommandEnvelope<DeviceWorkspaceIntent>
  ): Promise<DeviceOperationReceipt<
    PreparedWorkspaceLocationResult | ClonedProjectPresenceResult | CheckoutLifecycleResult
    | PushedWorkspaceBranchResult | FastForwardedWorkspaceBranchResult
  >> {
    const prior = this.options.operations.get(command.cockpitId, command.commandId);
    if (prior) {
      return this.options.operations.execute(
        command,
        command.intent.kind,
        async () => { throw new Error('A recorded command must never repeat its effects.'); }
      ) as Promise<DeviceOperationReceipt<
        PreparedWorkspaceLocationResult | ClonedProjectPresenceResult | CheckoutLifecycleResult
        | PushedWorkspaceBranchResult | FastForwardedWorkspaceBranchResult
      >>;
    }
    const plan = this.plans.get(command.planToken);
    if (!plan || plan.planId !== command.planToken.split('.', 1)[0]) {
      throw new WorkspacePlanError('plan_not_found', 'The Device plan token is unknown or expired.');
    }
    if (this.now().getTime() > Date.parse(plan.expiresAt)) {
      this.plans.delete(command.planToken);
      throw new WorkspacePlanError('plan_expired', 'The Device plan has expired; run preflight again.');
    }
    if (!plan.executable) throw new WorkspacePlanError('plan_blocked', plan.blockers.join(' '));
    if (
      command.targetDeviceId !== this.options.workspace.deviceId
      || command.capabilityRevision !== plan.capabilityRevision
      || command.planExpiresAt !== plan.expiresAt
      || !isDeepStrictEqual(command.intent, plan.intent)
      || command.expectedEntityVersions['device-workspace'] !== plan.expectedWorkspaceRevision
    ) throw new WorkspacePlanError('plan_mismatch', 'The command does not match its immutable Device plan.');
    return this.options.operations.execute(command, command.intent.kind, async () => {
      switch (command.intent.kind) {
        case 'prepare-workspace-location':
          return this.prepareWorkspaceLocation(plan, command.intent);
        case 'clone-project-presence':
          return this.cloneProjectPresence(plan, command.intent);
        case 'prepare-isolated-session-source':
          return this.prepareIsolatedSessionSource(plan, command.intent);
        case 'cleanup-isolated-checkout':
          return this.cleanupIsolatedCheckout(plan, command.intent);
        case 'promote-isolated-checkout':
          return this.promoteIsolatedCheckout(plan, command.intent);
        case 'push-workspace-branch':
          return this.pushWorkspaceBranch(plan, command.intent);
        case 'fetch-fast-forward-workspace-branch':
          return this.fetchFastForwardWorkspaceBranch(plan, command.intent);
        case 'publish-new-remote-branch':
          return this.publishNewRemoteBranch(plan, command.intent);
        default:
          throw new Error('Workspace Device command intent is unsupported.');
      }
    });
  }

  getCommand(cockpitId: string, commandId: string): DeviceOperationReceipt | null {
    return this.options.operations.get(cockpitId, commandId);
  }

  private async planWorkspaceLocation(
    intent: PrepareWorkspaceLocationIntent
  ): Promise<DeviceWorkspacePlan> {
    validatePrepareIntent(intent);
    const requestedPath = intent.path?.trim()
      ? intent.path
      : path.join(this.managedRoots[0]!, intent.checkoutId);
    const targetPath = await this.assertManagedTarget(requestedPath);
    const snapshot = this.options.workspace.snapshot();
    if (snapshot.checkouts.some((checkout) => checkout.id === intent.checkoutId)) {
      throw new WorkspacePlanError('checkout_exists', `Checkout already exists: ${intent.checkoutId}`);
    }
    const repository = snapshot.repositories.find((candidate) => candidate.id === intent.repositoryId);
    if (!repository) throw new WorkspacePlanError('repository_not_found', 'Project Presence is absent on this Device.');
    const repositoryCheckout = snapshot.checkouts.find((checkout) =>
      checkout.repositoryId === repository.id && checkout.role === 'main'
    ) ?? snapshot.checkouts.find((checkout) => checkout.repositoryId === repository.id);
    const blockers: string[] = [];
    const warnings: string[] = [];
    let existingBranchCheckoutPath: string | undefined;
    if (!repositoryCheckout || repositoryCheckout.lifecycle !== 'ready') {
      blockers.push('The Device Repository has no available Checkout from which to prepare a Worktree.');
    } else {
      const gitSource = sourceForGit(intent.source, blockers);
      if (gitSource?.kind === 'existing-branch') {
        const worktrees = await this.options.git.listWorktrees(
          repositoryCheckout.path,
          true,
          gitContext(intent)
        );
        const branchName = gitSource.ref.slice('refs/heads/'.length);
        existingBranchCheckoutPath = worktrees.find((worktree) =>
          worktree.branch === branchName
        )?.path;
        if (existingBranchCheckoutPath) {
          blockers.push(
            `Branch ${gitSource.ref} is already checked out at ${existingBranchCheckoutPath}; reuse or adopt it instead.`
          );
        }
      }
      const status = await this.options.git.getStatus(
        repositoryCheckout.path,
        true,
        gitContext(intent)
      );
      if (!status.isRepo) blockers.push('The recorded Repository Checkout is no longer a Git repository.');
      if (status.dirty) {
        warnings.push('The existing main Checkout is dirty; it will not be changed by Worktree preparation.');
      }
    }
    const createdAt = this.now();
    const planId = randomUUID();
    const planToken = `${planId}.${randomBytes(24).toString('base64url')}`;
    const plan: DeviceWorkspacePlan = {
      schemaVersion: 1,
      planId,
      planToken,
      targetDeviceId: this.options.workspace.deviceId,
      capabilityRevision: this.options.capabilityRevision,
      expectedWorkspaceRevision: snapshot.revision,
      intent: structuredClone({ ...intent, path: targetPath }),
      executable: blockers.length === 0,
      blockers,
      warnings,
      preview: {
        repositoryPath: repositoryCheckout?.path ?? null,
        targetPath,
        sourceLabel: sourceLabel(intent.source),
        ...(existingBranchCheckoutPath ? { existingBranchCheckoutPath } : {})
      },
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.planTtlMs).toISOString()
    };
    this.rememberPlan(plan);
    return structuredClone(plan);
  }

  private async prepareWorkspaceLocation(
    plan: DeviceWorkspacePlan,
    intent: PrepareWorkspaceLocationIntent
  ): Promise<PreparedWorkspaceLocationResult> {
    const targetPath = intent.path?.trim();
    if (!targetPath) {
      throw new WorkspacePlanError('plan_mismatch', 'The prepared Device plan has no target path.');
    }
    const current = this.options.workspace.snapshot();
    if (current.revision !== plan.expectedWorkspaceRevision) {
      throw new WorkspacePlanError(
        'workspace_revision_conflict',
        `Device Workspace revision changed from ${plan.expectedWorkspaceRevision} to ${current.revision}.`
      );
    }
    const repositoryCheckout = current.checkouts.find((checkout) =>
      checkout.repositoryId === intent.repositoryId && checkout.role === 'main'
    ) ?? current.checkouts.find((checkout) => checkout.repositoryId === intent.repositoryId);
    if (!repositoryCheckout || repositoryCheckout.lifecycle !== 'ready') {
      throw new WorkspacePlanError('repository_unavailable', 'The Device Repository Checkout is unavailable.');
    }
    const pending = await this.options.workspace.registerCheckout({
      expectedRevision: current.revision,
      checkout: {
        id: intent.checkoutId,
        repositoryId: intent.repositoryId,
        path: targetPath,
        runMode: intent.runMode,
        ...(intent.wslDistro ? { wslDistro: intent.wslDistro } : {}),
        role: 'workspace',
        lifecycle: 'pending'
      }
    });
    await this.options.git.addWorkspaceWorktree(
      repositoryCheckout.path,
      targetPath,
      requiredGitSource(intent.source),
      gitContext(intent)
    );
    const readySnapshot = await this.options.workspace.updateCheckout({
      expectedRevision: pending.revision,
      checkoutId: intent.checkoutId,
      expectedVersion: 1,
      lifecycle: 'ready'
    });
    const checkout = readySnapshot.checkouts.find((candidate) => candidate.id === intent.checkoutId);
    if (!checkout) throw new Error('Prepared Checkout disappeared from the Device registry.');
    this.plans.delete(plan.planToken);
    return { checkout: structuredClone(checkout), workspaceRevision: readySnapshot.revision };
  }

  private async planCloneProjectPresence(
    intent: CloneProjectPresenceIntent
  ): Promise<DeviceWorkspacePlan> {
    validateCloneIntent(intent);
    const targetPath = await this.assertManagedTarget(
      intent.path?.trim() ? intent.path : path.join(this.managedRoots[0]!, intent.checkoutId)
    );
    const snapshot = this.options.workspace.snapshot();
    if (snapshot.repositories.some((repository) => repository.id === intent.repositoryId)) {
      throw new WorkspacePlanError('repository_exists', `Repository already exists: ${intent.repositoryId}`);
    }
    if (snapshot.checkouts.some((checkout) => checkout.id === intent.checkoutId)) {
      throw new WorkspacePlanError('checkout_exists', `Checkout already exists: ${intent.checkoutId}`);
    }
    const createdAt = this.now();
    const planId = randomUUID();
    const planToken = `${planId}.${randomBytes(24).toString('base64url')}`;
    const normalizedIntent: CloneProjectPresenceIntent = {
      ...structuredClone(intent),
      sourceUrl: intent.sourceUrl.trim(),
      path: targetPath,
      ...(intent.branchRef ? { branchRef: requiredBranchRef(intent.branchRef) } : {})
    };
    const plan: DeviceWorkspacePlan = {
      schemaVersion: 1,
      planId,
      planToken,
      targetDeviceId: this.options.workspace.deviceId,
      capabilityRevision: this.options.capabilityRevision,
      expectedWorkspaceRevision: snapshot.revision,
      intent: normalizedIntent,
      executable: true,
      blockers: [],
      warnings: ['Clone creates a new Repository and Checkout on this Device.'],
      preview: {
        repositoryPath: null,
        targetPath,
        sourceLabel: normalizedIntent.branchRef ?? normalizedIntent.sourceUrl
      },
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.planTtlMs).toISOString()
    };
    this.rememberPlan(plan);
    return structuredClone(plan);
  }

  private async cloneProjectPresence(
    plan: DeviceWorkspacePlan,
    intent: CloneProjectPresenceIntent
  ): Promise<ClonedProjectPresenceResult> {
    const targetPath = intent.path?.trim();
    if (!targetPath) throw new WorkspacePlanError('plan_mismatch', 'Clone plan has no target path.');
    const current = this.options.workspace.snapshot();
    if (current.revision !== plan.expectedWorkspaceRevision) {
      throw new WorkspacePlanError(
        'workspace_revision_conflict',
        `Device Workspace revision changed from ${plan.expectedWorkspaceRevision} to ${current.revision}.`
      );
    }
    const pending = await this.options.workspace.registerRepository({
      expectedRevision: current.revision,
      repository: {
        id: intent.repositoryId,
        identity: structuredClone(intent.identity)
      },
      mainCheckout: {
        id: intent.checkoutId,
        repositoryId: intent.repositoryId,
        path: targetPath,
        runMode: intent.runMode,
        ...(intent.wslDistro ? { wslDistro: intent.wslDistro } : {}),
        role: 'main',
        lifecycle: 'pending'
      }
    });
    await this.options.git.cloneRepository(intent.sourceUrl, targetPath, {
      ...(intent.branchRef ? { branchRef: intent.branchRef } : {}),
      runMode: intent.runMode,
      ...(intent.wslDistro ? { wslDistro: intent.wslDistro } : {})
    });
    const ready = await this.options.workspace.updateCheckout({
      expectedRevision: pending.revision,
      checkoutId: intent.checkoutId,
      expectedVersion: 1,
      lifecycle: 'ready'
    });
    const repository = ready.repositories.find((candidate) => candidate.id === intent.repositoryId);
    const checkout = ready.checkouts.find((candidate) => candidate.id === intent.checkoutId);
    if (!repository || !checkout) throw new Error('Cloned Project Presence disappeared from its registry.');
    this.plans.delete(plan.planToken);
    return {
      repository: structuredClone(repository),
      checkout: structuredClone(checkout),
      workspaceRevision: ready.revision
    };
  }

  private async planIsolatedSessionSource(
    intent: PrepareIsolatedSessionSourceIntent
  ): Promise<DeviceWorkspacePlan> {
    validateIsolatedIntent(intent);
    const targetPath = await this.assertManagedTarget(
      intent.path?.trim() ? intent.path : path.join(this.managedRoots[0]!, intent.checkoutId)
    );
    const snapshot = this.options.workspace.snapshot();
    if (snapshot.checkouts.some((checkout) => checkout.id === intent.checkoutId)) {
      throw new WorkspacePlanError('checkout_exists', `Checkout already exists: ${intent.checkoutId}`);
    }
    const repository = snapshot.repositories.find((candidate) => candidate.id === intent.repositoryId);
    if (!repository) throw new WorkspacePlanError('repository_not_found', 'Project Presence is absent on this Device.');
    const repositoryCheckout = snapshot.checkouts.find((checkout) =>
      checkout.repositoryId === repository.id && checkout.role === 'main'
    ) ?? snapshot.checkouts.find((checkout) => checkout.repositoryId === repository.id);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const branchRef = intent.detached
      ? undefined
      : requiredBranchRef(intent.branchRef ?? generatedSessionBranch(intent));
    if (!repositoryCheckout || repositoryCheckout.lifecycle !== 'ready') {
      blockers.push('The Device Repository has no available Checkout from which to prepare an isolated Worktree.');
    } else {
      const relation = await this.options.git.compareRevisions(
        repositoryCheckout.path,
        intent.baseOid,
        intent.baseOid,
        gitContext(intent)
      );
      if (relation === 'missing') blockers.push('The isolated base revision is unavailable on this Device.');
      if (branchRef) {
        const branches = await this.options.git.listLocalBranches(
          repositoryCheckout.path,
          true,
          gitContext(intent)
        );
        if (branches.some((branch) => branch.name === branchRef.slice('refs/heads/'.length))) {
          blockers.push(`Generated Branch already exists: ${branchRef}`);
        }
      }
      const status = await this.options.git.getStatus(
        repositoryCheckout.path,
        true,
        gitContext(intent)
      );
      if (status.dirty) warnings.push('The Repository Checkout is dirty; isolated preparation will not modify it.');
    }
    const createdAt = this.now();
    const planId = randomUUID();
    const planToken = `${planId}.${randomBytes(24).toString('base64url')}`;
    const normalizedIntent: PrepareIsolatedSessionSourceIntent = {
      ...structuredClone(intent),
      path: targetPath,
      ...(branchRef ? { branchRef } : {})
    };
    const plan: DeviceWorkspacePlan = {
      schemaVersion: 1,
      planId,
      planToken,
      targetDeviceId: this.options.workspace.deviceId,
      capabilityRevision: this.options.capabilityRevision,
      expectedWorkspaceRevision: snapshot.revision,
      intent: normalizedIntent,
      executable: blockers.length === 0,
      blockers,
      warnings,
      preview: {
        repositoryPath: repositoryCheckout?.path ?? null,
        targetPath,
        sourceLabel: branchRef ?? `detached ${intent.baseOid}`
      },
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.planTtlMs).toISOString()
    };
    this.rememberPlan(plan);
    return structuredClone(plan);
  }

  private async prepareIsolatedSessionSource(
    plan: DeviceWorkspacePlan,
    intent: PrepareIsolatedSessionSourceIntent
  ): Promise<PreparedWorkspaceLocationResult> {
    const targetPath = intent.path?.trim();
    if (!targetPath) throw new WorkspacePlanError('plan_mismatch', 'Isolated plan has no target path.');
    const current = this.options.workspace.snapshot();
    if (current.revision !== plan.expectedWorkspaceRevision) {
      throw new WorkspacePlanError(
        'workspace_revision_conflict',
        `Device Workspace revision changed from ${plan.expectedWorkspaceRevision} to ${current.revision}.`
      );
    }
    const repositoryCheckout = current.checkouts.find((checkout) =>
      checkout.repositoryId === intent.repositoryId && checkout.role === 'main'
    ) ?? current.checkouts.find((checkout) => checkout.repositoryId === intent.repositoryId);
    if (!repositoryCheckout || repositoryCheckout.lifecycle !== 'ready') {
      throw new WorkspacePlanError('repository_unavailable', 'The Device Repository Checkout is unavailable.');
    }
    const pending = await this.options.workspace.registerCheckout({
      expectedRevision: current.revision,
      checkout: {
        id: intent.checkoutId,
        repositoryId: intent.repositoryId,
        path: targetPath,
        runMode: intent.runMode,
        ...(intent.wslDistro ? { wslDistro: intent.wslDistro } : {}),
        role: 'isolated-session',
        ownerSessionId: intent.ownerSessionId,
        lifecycle: 'pending'
      }
    });
    await this.options.git.addWorkspaceWorktree(
      repositoryCheckout.path,
      targetPath,
      intent.detached
        ? { kind: 'detached', oid: intent.baseOid }
        : {
            kind: 'new-branch',
            ref: requiredBranchRef(intent.branchRef ?? generatedSessionBranch(intent)),
            baseOid: intent.baseOid
          },
      gitContext(intent)
    );
    const ready = await this.options.workspace.updateCheckout({
      expectedRevision: pending.revision,
      checkoutId: intent.checkoutId,
      expectedVersion: 1,
      lifecycle: 'ready'
    });
    const checkout = ready.checkouts.find((candidate) => candidate.id === intent.checkoutId);
    if (!checkout) throw new Error('Prepared isolated Checkout disappeared from the Device registry.');
    this.plans.delete(plan.planToken);
    return { checkout: structuredClone(checkout), workspaceRevision: ready.revision };
  }

  private async planCleanupIsolatedCheckout(
    intent: CleanupIsolatedCheckoutIntent
  ): Promise<DeviceWorkspacePlan> {
    validateCheckoutOwnershipIntent(intent);
    const snapshot = this.options.workspace.snapshot();
    const checkout = requiredOwnedCheckout(snapshot.checkouts, intent);
    const report = await this.lossScanner.scan(checkout.id);
    return this.lifecyclePlan(intent, checkout, snapshot.revision, report, report.blockers.map((item) => item.message), [
      'Cleanup removes the isolated Worktree without force. Its generated Branch is retained.'
    ]);
  }

  private async planPromoteIsolatedCheckout(
    intent: PromoteIsolatedCheckoutIntent
  ): Promise<DeviceWorkspacePlan> {
    validateCheckoutOwnershipIntent(intent);
    const snapshot = this.options.workspace.snapshot();
    const checkout = requiredOwnedCheckout(snapshot.checkouts, intent);
    const report = await this.lossScanner.scan(checkout.id);
    const fatal = fatalPromotionBlockers(report, intent.expectedOwnerSessionId);
    const warnings = report.blockers
      .filter((item) => !fatal.includes(item))
      .map((item) => item.message);
    warnings.push('Promotion preserves the Worktree and atomically clears its Session ownership.');
    return this.lifecyclePlan(
      intent,
      checkout,
      snapshot.revision,
      report,
      fatal.map((item) => item.message),
      warnings
    );
  }

  private lifecyclePlan(
    intent: CleanupIsolatedCheckoutIntent | PromoteIsolatedCheckoutIntent,
    checkout: CheckoutRecord,
    expectedWorkspaceRevision: number,
    report: CheckoutLossReport,
    blockers: string[],
    warnings: string[]
  ): DeviceWorkspacePlan {
    const snapshot = this.options.workspace.snapshot();
    const repositoryCheckout = snapshot.checkouts.find((candidate) =>
      candidate.repositoryId === checkout.repositoryId
      && candidate.id !== checkout.id
      && candidate.role === 'main'
      && candidate.lifecycle === 'ready'
    ) ?? snapshot.checkouts.find((candidate) =>
      candidate.repositoryId === checkout.repositoryId
      && candidate.id !== checkout.id
      && candidate.lifecycle === 'ready'
    );
    if (!repositoryCheckout) blockers.push('The owning Repository Checkout is unavailable.');
    const createdAt = this.now();
    const planId = randomUUID();
    const planToken = `${planId}.${randomBytes(24).toString('base64url')}`;
    const plan: DeviceWorkspacePlan = {
      schemaVersion: 1,
      planId,
      planToken,
      targetDeviceId: this.options.workspace.deviceId,
      capabilityRevision: this.options.capabilityRevision,
      expectedWorkspaceRevision,
      intent: structuredClone(intent),
      executable: blockers.length === 0,
      blockers,
      warnings,
      preview: {
        repositoryPath: repositoryCheckout?.path ?? null,
        targetPath: checkout.path,
        sourceLabel: intent.kind === 'cleanup-isolated-checkout'
          ? 'Remove isolated Worktree'
          : 'Promote isolated Worktree'
      },
      lossReport: structuredClone(report),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.planTtlMs).toISOString()
    };
    this.rememberPlan(plan);
    return structuredClone(plan);
  }

  private async cleanupIsolatedCheckout(
    plan: DeviceWorkspacePlan,
    intent: CleanupIsolatedCheckoutIntent
  ): Promise<CheckoutLifecycleResult> {
    const current = this.options.workspace.snapshot();
    requirePlannedWorkspaceRevision(current.revision, plan.expectedWorkspaceRevision);
    const checkout = requiredOwnedCheckout(current.checkouts, intent);
    if (checkout.version !== plan.lossReport?.checkoutVersion) {
      throw new WorkspacePlanError('checkout_version_conflict', 'Checkout changed after cleanup preflight.');
    }
    const fresh = await this.lossScanner.scan(checkout.id);
    if (!fresh.eligible) {
      throw new WorkspacePlanError('loss_scan_blocked', fresh.blockers.map((item) => item.message).join(' '));
    }
    const repositoryCheckout = requiredRepositoryCheckout(current.checkouts, checkout);
    const planned = await this.options.workspace.updateCheckout({
      expectedRevision: current.revision,
      checkoutId: checkout.id,
      expectedVersion: checkout.version,
      lifecycle: 'cleanup-planned'
    });
    await this.options.git.removeWorkspaceWorktree(
      repositoryCheckout.path,
      checkout.path,
      checkoutContext(checkout)
    );
    const cleanupPlanned = planned.checkouts.find((candidate) => candidate.id === checkout.id);
    if (!cleanupPlanned) throw new Error('Cleanup-planned Checkout disappeared from the Device registry.');
    const removed = await this.options.workspace.updateCheckout({
      expectedRevision: planned.revision,
      checkoutId: checkout.id,
      expectedVersion: cleanupPlanned.version,
      lifecycle: 'removed'
    });
    const result = removed.checkouts.find((candidate) => candidate.id === checkout.id);
    if (!result) throw new Error('Removed Checkout disappeared from the Device registry.');
    this.plans.delete(plan.planToken);
    return { checkout: structuredClone(result), workspaceRevision: removed.revision };
  }

  private async promoteIsolatedCheckout(
    plan: DeviceWorkspacePlan,
    intent: PromoteIsolatedCheckoutIntent
  ): Promise<CheckoutLifecycleResult> {
    const current = this.options.workspace.snapshot();
    requirePlannedWorkspaceRevision(current.revision, plan.expectedWorkspaceRevision);
    const checkout = requiredOwnedCheckout(current.checkouts, intent);
    if (checkout.version !== plan.lossReport?.checkoutVersion) {
      throw new WorkspacePlanError('checkout_version_conflict', 'Checkout changed after promotion preflight.');
    }
    const fresh = await this.lossScanner.scan(checkout.id);
    const fatal = fatalPromotionBlockers(fresh, intent.expectedOwnerSessionId);
    if (fatal.length > 0) {
      throw new WorkspacePlanError('promotion_blocked', fatal.map((item) => item.message).join(' '));
    }
    const promoted = await this.options.workspace.updateCheckout({
      expectedRevision: current.revision,
      checkoutId: checkout.id,
      expectedVersion: checkout.version,
      role: 'workspace',
      ownerSessionId: null
    });
    const result = promoted.checkouts.find((candidate) => candidate.id === checkout.id);
    if (!result) throw new Error('Promoted Checkout disappeared from the Device registry.');
    this.plans.delete(plan.planToken);
    return { checkout: structuredClone(result), workspaceRevision: promoted.revision };
  }

  private async planPushWorkspaceBranch(
    intent: PushWorkspaceBranchIntent
  ): Promise<DeviceWorkspacePlan> {
    validateAlignmentIntent(intent);
    const snapshot = this.options.workspace.snapshot();
    const checkout = requiredReadyAlignmentCheckout(snapshot.checkouts, intent.checkoutId);
    const context = checkoutContext(checkout);
    const [status, evidence] = await Promise.all([
      this.options.git.getStatus(checkout.path, true, context),
      this.options.git.inspectRemoteEvidence(checkout.path, {
        remote: intent.remote,
        branchRef: intent.branchRef,
        ...context
      })
    ]);
    const blockers: string[] = [];
    if (!status.head || evidence.localOid !== status.head) {
      blockers.push('The Checkout Branch has no stable local revision to publish.');
    }
    if (status.detached || status.branch !== intent.branchRef.slice('refs/heads/'.length)) {
      blockers.push(`The Checkout is not on ${intent.branchRef}.`);
    }
    if (intent.expectedLocalOid && intent.expectedLocalOid !== evidence.localOid) {
      blockers.push('The requested local revision differs from current Device evidence.');
    }
    if ('expectedRemoteOid' in intent && intent.expectedRemoteOid !== evidence.remoteOid) {
      blockers.push('The requested remote revision differs from current Device evidence.');
    }
    const normalized: PushWorkspaceBranchIntent = {
      ...structuredClone(intent),
      expectedLocalOid: evidence.localOid ?? undefined,
      expectedRemoteOid: evidence.remoteOid
    };
    return this.alignmentPlan(
      normalized,
      checkout,
      snapshot.revision,
      evidence,
      blockers,
      ['Push publishes only the named Branch and never force-pushes.']
    );
  }

  private async planPublishNewRemoteBranch(
    intent: PublishNewRemoteBranchIntent
  ): Promise<DeviceWorkspacePlan> {
    validatePublicationIntent(intent);
    const snapshot = this.options.workspace.snapshot();
    const checkout = requiredReadyAlignmentCheckout(snapshot.checkouts, intent.checkoutId);
    const context = checkoutContext(checkout);
    const [status, remoteExists] = await Promise.all([
      this.options.git.getStatus(checkout.path, true, context),
      this.options.git.hasRemote(checkout.path, intent.remote, context)
    ]);
    const blockers: string[] = [];
    if (remoteExists) blockers.push(`Git remote already exists: ${intent.remote}`);
    if (!status.head) blockers.push('The Checkout Branch has no stable local revision to publish.');
    if (status.detached || status.branch !== intent.branchRef.slice('refs/heads/'.length)) {
      blockers.push(`The Checkout is not on ${intent.branchRef}.`);
    }
    if (intent.expectedLocalOid && intent.expectedLocalOid !== status.head) {
      blockers.push('The requested local revision differs from current Device evidence.');
    }
    const normalized: PublishNewRemoteBranchIntent = {
      ...structuredClone(intent),
      expectedLocalOid: status.head ?? undefined
    };
    const createdAt = this.now();
    const planId = randomUUID();
    const planToken = `${planId}.${randomBytes(24).toString('base64url')}`;
    const plan: DeviceWorkspacePlan = {
      schemaVersion: 1,
      planId,
      planToken,
      targetDeviceId: this.options.workspace.deviceId,
      capabilityRevision: this.options.capabilityRevision,
      expectedWorkspaceRevision: snapshot.revision,
      expectedCheckoutVersion: checkout.version,
      intent: normalized,
      executable: blockers.length === 0,
      blockers,
      warnings: [
        'Publication adds the named remote and performs a normal push. The remote remains configured if push fails.'
      ],
      preview: {
        repositoryPath: checkout.path,
        targetPath: checkout.path,
        sourceLabel: intent.branchRef
      },
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.planTtlMs).toISOString()
    };
    this.rememberPlan(plan);
    return structuredClone(plan);
  }

  private async planFetchFastForwardWorkspaceBranch(
    intent: FetchFastForwardWorkspaceBranchIntent
  ): Promise<DeviceWorkspacePlan> {
    validateAlignmentIntent(intent);
    const snapshot = this.options.workspace.snapshot();
    const checkout = requiredReadyAlignmentCheckout(snapshot.checkouts, intent.checkoutId);
    const context = checkoutContext(checkout);
    const targetOid = requiredFullOid(intent.targetOid);
    const [status, evidence] = await Promise.all([
      this.options.git.getStatus(checkout.path, true, context),
      this.options.git.inspectRemoteEvidence(checkout.path, {
        remote: intent.remote,
        branchRef: intent.branchRef,
        ...context
      })
    ]);
    const blockers: string[] = [];
    const relation = status.head
      ? await this.options.git.compareRevisions(checkout.path, status.head, targetOid, context)
      : 'missing';
    if (!status.head) blockers.push('The target Checkout has no current revision.');
    if (status.dirty) blockers.push('A dirty Checkout cannot be fast-forwarded.');
    if (status.detached || status.branch !== intent.branchRef.slice('refs/heads/'.length)) {
      blockers.push(`The target Checkout is not on ${intent.branchRef}.`);
    }
    if (intent.expectedHeadOid && intent.expectedHeadOid !== status.head) {
      blockers.push('The requested target HEAD differs from current Device evidence.');
    }
    if (['left-ahead', 'diverged', 'unrelated'].includes(relation)) {
      blockers.push('The target Checkout cannot be proven to fast-forward to the source revision.');
    }
    const normalized: FetchFastForwardWorkspaceBranchIntent = {
      ...structuredClone(intent),
      targetOid,
      expectedHeadOid: status.head ?? undefined,
      expectedRemoteOid: intent.expectedRemoteOid ?? targetOid
    };
    const plan = this.alignmentPlan(
      normalized,
      checkout,
      snapshot.revision,
      evidence,
      blockers,
      evidence.remoteOid === targetOid
        ? ['Fetch will refresh evidence before a proven fast-forward.']
        : ['The expected revision must be published before this Device fetches and fast-forwards.']
    );
    plan.revisionRelation = relation;
    this.rememberPlan(plan);
    return structuredClone(plan);
  }

  private alignmentPlan(
    intent: PushWorkspaceBranchIntent | FetchFastForwardWorkspaceBranchIntent,
    checkout: CheckoutRecord,
    expectedWorkspaceRevision: number,
    remoteEvidence: NonNullable<DeviceWorkspacePlan['remoteEvidence']>,
    blockers: string[],
    warnings: string[]
  ): DeviceWorkspacePlan {
    const createdAt = this.now();
    const planId = randomUUID();
    const planToken = `${planId}.${randomBytes(24).toString('base64url')}`;
    const plan: DeviceWorkspacePlan = {
      schemaVersion: 1,
      planId,
      planToken,
      targetDeviceId: this.options.workspace.deviceId,
      capabilityRevision: this.options.capabilityRevision,
      expectedWorkspaceRevision,
      expectedCheckoutVersion: checkout.version,
      intent: structuredClone(intent),
      executable: blockers.length === 0,
      blockers,
      warnings,
      preview: {
        repositoryPath: checkout.path,
        targetPath: checkout.path,
        sourceLabel: intent.branchRef
      },
      remoteEvidence: structuredClone(remoteEvidence),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.planTtlMs).toISOString()
    };
    this.rememberPlan(plan);
    return structuredClone(plan);
  }

  private async pushWorkspaceBranch(
    plan: DeviceWorkspacePlan,
    intent: PushWorkspaceBranchIntent
  ): Promise<PushedWorkspaceBranchResult> {
    const current = this.options.workspace.snapshot();
    requirePlannedWorkspaceRevision(current.revision, plan.expectedWorkspaceRevision);
    const checkout = requiredReadyAlignmentCheckout(current.checkouts, intent.checkoutId);
    requirePlannedCheckoutVersion(checkout, plan);
    if (!intent.expectedLocalOid || !('expectedRemoteOid' in intent)) {
      throw new WorkspacePlanError('plan_mismatch', 'Push plan lacks immutable revision evidence.');
    }
    const evidence = await this.options.git.pushBranch(checkout.path, {
      remote: intent.remote,
      branchRef: intent.branchRef,
      expectedLocalOid: intent.expectedLocalOid,
      expectedRemoteOid: intent.expectedRemoteOid ?? null,
      ...checkoutContext(checkout)
    });
    this.plans.delete(plan.planToken);
    return { checkout: structuredClone(checkout), evidence, workspaceRevision: current.revision };
  }

  private async fetchFastForwardWorkspaceBranch(
    plan: DeviceWorkspacePlan,
    intent: FetchFastForwardWorkspaceBranchIntent
  ): Promise<FastForwardedWorkspaceBranchResult> {
    const current = this.options.workspace.snapshot();
    requirePlannedWorkspaceRevision(current.revision, plan.expectedWorkspaceRevision);
    const checkout = requiredReadyAlignmentCheckout(current.checkouts, intent.checkoutId);
    requirePlannedCheckoutVersion(checkout, plan);
    if (!intent.expectedHeadOid || !intent.expectedRemoteOid) {
      throw new WorkspacePlanError('plan_mismatch', 'Fast-forward plan lacks immutable revision evidence.');
    }
    const context = checkoutContext(checkout);
    const evidence = await this.options.git.fetchRemoteEvidence(checkout.path, {
      remote: intent.remote,
      branchRef: intent.branchRef,
      ...context
    });
    if (evidence.remoteOid !== intent.expectedRemoteOid || evidence.remoteOid !== intent.targetOid) {
      throw new WorkspacePlanError('remote_revision_conflict', 'Remote Branch does not match the planned revision.');
    }
    const status = await this.options.git.fastForwardBranch(checkout.path, {
      branchRef: intent.branchRef,
      expectedHeadOid: intent.expectedHeadOid,
      targetOid: intent.targetOid,
      ...context
    });
    this.plans.delete(plan.planToken);
    return {
      checkout: structuredClone(checkout),
      evidence,
      status,
      workspaceRevision: current.revision
    };
  }

  private async publishNewRemoteBranch(
    plan: DeviceWorkspacePlan,
    intent: PublishNewRemoteBranchIntent
  ): Promise<PushedWorkspaceBranchResult> {
    const current = this.options.workspace.snapshot();
    requirePlannedWorkspaceRevision(current.revision, plan.expectedWorkspaceRevision);
    const checkout = requiredReadyAlignmentCheckout(current.checkouts, intent.checkoutId);
    requirePlannedCheckoutVersion(checkout, plan);
    if (!intent.expectedLocalOid) {
      throw new WorkspacePlanError('plan_mismatch', 'Publication plan lacks immutable local revision evidence.');
    }
    const evidence = await this.options.git.publishNewRemoteBranch(checkout.path, {
      remote: intent.remote,
      remoteUrl: intent.remoteUrl,
      branchRef: intent.branchRef,
      expectedLocalOid: intent.expectedLocalOid,
      ...checkoutContext(checkout)
    });
    this.plans.delete(plan.planToken);
    return { checkout: structuredClone(checkout), evidence, workspaceRevision: current.revision };
  }

  private async assertManagedTarget(target: string): Promise<string> {
    const resolved = path.resolve(target.trim());
    const root = this.managedRoots.find((candidate) => containsPath(candidate, resolved));
    if (!root) throw new WorkspacePlanError('path_outside_managed_root', 'Target path is outside every managed root.');
    const realRoot = await fs.realpath(root).catch(() => root);
    const ancestor = await nearestExistingAncestor(path.dirname(resolved));
    const realAncestor = await fs.realpath(ancestor).catch(() => ancestor);
    if (!containsPath(realRoot, realAncestor)) {
      throw new WorkspacePlanError('path_symlink_escape', 'Target path escapes its managed root through a symlink.');
    }
    return resolved;
  }

  private rememberPlan(plan: DeviceWorkspacePlan): void {
    for (const [token, previous] of this.plans) {
      if (this.now().getTime() > Date.parse(previous.expiresAt)) this.plans.delete(token);
    }
    if (this.plans.size >= MAX_ACTIVE_PLANS) {
      const oldest = [...this.plans.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      )[0];
      if (oldest) this.plans.delete(oldest.planToken);
    }
    this.plans.set(plan.planToken, structuredClone(plan));
  }
}

export class WorkspacePlanError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspacePlanError';
  }
}

function validatePrepareIntent(intent: PrepareWorkspaceLocationIntent): void {
  if (
    !isDeviceId(intent.repositoryId)
    || !isDeviceId(intent.checkoutId)
    || (intent.runMode === 'wsl' && !intent.wslDistro?.trim())
  ) throw new WorkspacePlanError('invalid_intent', 'Workspace Location intent is invalid.');
}

function validateCloneIntent(intent: CloneProjectPresenceIntent): void {
  const source = intent.sourceUrl?.trim();
  if (
    !isDeviceId(intent.repositoryId)
    || !isDeviceId(intent.checkoutId)
    || !source
    || source.length > 4_096
    || source.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(source)
    || (intent.runMode === 'wsl' && !intent.wslDistro?.trim())
    || !intent.identity
  ) throw new WorkspacePlanError('invalid_intent', 'Project clone intent is invalid.');
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      throw new WorkspacePlanError('invalid_clone_url', 'Project clone URL is invalid.');
    }
    if (parsed.username || parsed.password) {
      throw new WorkspacePlanError('credentials_in_url', 'Project clone URL must not embed credentials.');
    }
  }
  if (intent.branchRef) requiredBranchRef(intent.branchRef);
}

function validateIsolatedIntent(intent: PrepareIsolatedSessionSourceIntent): void {
  if (
    !isDeviceId(intent.repositoryId)
    || !isDeviceId(intent.checkoutId)
    || !intent.ownerSessionId?.trim()
    || intent.ownerSessionId.length > 256
    || !/^[0-9a-fA-F]{40,64}$/u.test(intent.baseOid)
    || typeof intent.detached !== 'boolean'
    || (intent.detached && intent.branchRef !== undefined)
    || (intent.runMode === 'wsl' && !intent.wslDistro?.trim())
  ) throw new WorkspacePlanError('invalid_intent', 'Isolated Session Source intent is invalid.');
  if (intent.branchRef) requiredBranchRef(intent.branchRef);
}

function validateCheckoutOwnershipIntent(
  intent: CleanupIsolatedCheckoutIntent | PromoteIsolatedCheckoutIntent
): void {
  if (!isDeviceId(intent.checkoutId) || !isDeviceId(intent.expectedOwnerSessionId)) {
    throw new WorkspacePlanError('invalid_intent', 'Checkout lifecycle intent is invalid.');
  }
}

function validateAlignmentIntent(
  intent: PushWorkspaceBranchIntent | FetchFastForwardWorkspaceBranchIntent
): void {
  if (
    !isDeviceId(intent.checkoutId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(intent.remote?.trim())
  ) throw new WorkspacePlanError('invalid_intent', 'Workspace alignment intent is invalid.');
  requiredBranchRef(intent.branchRef);
  if (intent.kind === 'push-workspace-branch') {
    if (intent.expectedLocalOid) requiredFullOid(intent.expectedLocalOid);
    if (intent.expectedRemoteOid) requiredFullOid(intent.expectedRemoteOid);
  } else {
    requiredFullOid(intent.targetOid);
    if (intent.expectedHeadOid) requiredFullOid(intent.expectedHeadOid);
    if (intent.expectedRemoteOid) requiredFullOid(intent.expectedRemoteOid);
  }
}

function validatePublicationIntent(intent: PublishNewRemoteBranchIntent): void {
  const remoteUrl = intent.remoteUrl?.trim();
  if (
    !isDeviceId(intent.checkoutId)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(intent.remote?.trim())
    || !remoteUrl
    || remoteUrl.length > 4_096
    || remoteUrl.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(remoteUrl)
  ) throw new WorkspacePlanError('invalid_intent', 'Workspace publication intent is invalid.');
  requiredBranchRef(intent.branchRef);
  if (intent.expectedLocalOid) requiredFullOid(intent.expectedLocalOid);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(remoteUrl)) {
    let parsed: URL;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      throw new WorkspacePlanError('invalid_remote_url', 'Workspace publication remote URL is invalid.');
    }
    if (parsed.username || parsed.password || !['https:', 'ssh:', 'file:'].includes(parsed.protocol)) {
      throw new WorkspacePlanError(
        'invalid_remote_url',
        'Workspace publication remote URL protocol or credentials are not allowed.'
      );
    }
  }
}

function requiredFullOid(value: string): string {
  const oid = value?.trim().toLowerCase();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(oid)) {
    throw new WorkspacePlanError('invalid_oid', 'Workspace alignment requires a full object ID.');
  }
  return oid;
}

function requiredReadyAlignmentCheckout(
  checkouts: CheckoutRecord[],
  checkoutId: string
): CheckoutRecord {
  const checkout = checkouts.find((candidate) => candidate.id === checkoutId);
  if (!checkout || checkout.lifecycle !== 'ready') {
    throw new WorkspacePlanError('checkout_unavailable', 'Workspace alignment Checkout is unavailable.');
  }
  if (checkout.role === 'external') {
    throw new WorkspacePlanError('checkout_role', 'External Checkouts cannot be aligned automatically.');
  }
  return checkout;
}

function requirePlannedCheckoutVersion(checkout: CheckoutRecord, plan: DeviceWorkspacePlan): void {
  if (checkout.version !== plan.expectedCheckoutVersion) {
    throw new WorkspacePlanError('checkout_version_conflict', 'Checkout changed after alignment preflight.');
  }
}

function requiredOwnedCheckout(
  checkouts: CheckoutRecord[],
  intent: CleanupIsolatedCheckoutIntent | PromoteIsolatedCheckoutIntent
): CheckoutRecord {
  const checkout = checkouts.find((candidate) => candidate.id === intent.checkoutId);
  if (!checkout) throw new WorkspacePlanError('checkout_not_found', 'Isolated Checkout was not found.');
  if (
    checkout.role !== 'isolated-session'
    || checkout.ownerSessionId !== intent.expectedOwnerSessionId
  ) throw new WorkspacePlanError('checkout_owner_conflict', 'Isolated Checkout ownership changed.');
  return checkout;
}

function requiredRepositoryCheckout(
  checkouts: CheckoutRecord[],
  checkout: CheckoutRecord
): CheckoutRecord {
  const repositoryCheckout = checkouts.find((candidate) =>
    candidate.repositoryId === checkout.repositoryId
    && candidate.id !== checkout.id
    && candidate.role === 'main'
    && candidate.lifecycle === 'ready'
  ) ?? checkouts.find((candidate) =>
    candidate.repositoryId === checkout.repositoryId
    && candidate.id !== checkout.id
    && candidate.lifecycle === 'ready'
  );
  if (!repositoryCheckout) {
    throw new WorkspacePlanError('repository_unavailable', 'The owning Repository Checkout is unavailable.');
  }
  return repositoryCheckout;
}

function requirePlannedWorkspaceRevision(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new WorkspacePlanError(
      'workspace_revision_conflict',
      `Device Workspace revision changed from ${expected} to ${actual}.`
    );
  }
}

function fatalPromotionBlockers(report: CheckoutLossReport, ownerSessionId: string) {
  const fatalCodes = new Set([
    'lifecycle',
    'main',
    'role',
    'ownership',
    'uncertain',
    'branch',
    'operation'
  ]);
  const hasOtherConsumer = report.activeConsumerSessionIds.some((id) => id !== ownerSessionId);
  return report.blockers.filter((blocker) =>
    fatalCodes.has(blocker.code) || (blocker.code === 'consumer' && hasOtherConsumer)
  );
}

function checkoutContext(checkout: CheckoutRecord) {
  return {
    runMode: checkout.runMode,
    ...(checkout.wslDistro ? { wslDistro: checkout.wslDistro } : {})
  };
}

function generatedSessionBranch(intent: PrepareIsolatedSessionSourceIntent): string {
  const session = intent.ownerSessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 16) || 'session';
  return `refs/heads/soloe/session/${session}-${intent.checkoutId.slice(0, 8)}`;
}

function requiredBranchRef(value: string): string {
  const ref = value.trim();
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(ref) || ref.includes('..')) {
    throw new WorkspacePlanError('invalid_branch_ref', 'Project clone Branch ref is invalid.');
  }
  return ref;
}

function sourceForGit(
  source: WorkspaceSource,
  blockers: string[]
): GitWorkspaceWorktreeSource | null {
  if (source.kind === 'branch') {
    if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(source.localRef)) {
      blockers.push('Workspace Branch Source is not a valid full local Branch ref.');
      return null;
    }
    return { kind: 'existing-branch', ref: source.localRef };
  }
  if (source.kind === 'revision') {
    if (!/^[0-9a-fA-F]{40,64}$/u.test(source.oid)) {
      blockers.push('Workspace Revision Source is not a full object ID.');
      return null;
    }
    return { kind: 'detached', oid: source.oid };
  }
  if (!source.lastResolved?.oid) {
    blockers.push('Pull Request Source has no resolved revision evidence on this Device.');
    return null;
  }
  return { kind: 'detached', oid: source.lastResolved.oid };
}

function requiredGitSource(source: WorkspaceSource): GitWorkspaceWorktreeSource {
  const blockers: string[] = [];
  const result = sourceForGit(source, blockers);
  if (!result) throw new WorkspacePlanError('source_unresolved', blockers.join(' '));
  return result;
}

function sourceLabel(source: WorkspaceSource): string {
  if (source.kind === 'branch') return source.localRef;
  if (source.kind === 'pull_request') return `GitHub PR #${source.number}`;
  return source.label?.trim() || source.oid;
}

function gitContext(intent: { runMode: string; wslDistro?: string }) {
  return {
    runMode: intent.runMode as CheckoutRecord['runMode'],
    ...(intent.wslDistro ? { wslDistro: intent.wslDistro } : {})
  };
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(input: string): Promise<string> {
  let current = input;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
