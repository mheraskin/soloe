import { randomUUID } from 'node:crypto';

import type { DeviceCommandEnvelope } from '@shared/types/commands.js';
import type {
  CheckoutRecord,
  CockpitCatalogSnapshot,
  CockpitPlaceSessionIntent,
  CockpitPlaceSessionOperation,
  CockpitPlaceSessionPlan,
  CockpitPlaceSessionResult,
  DeviceWorkspaceIntent,
  PreparedWorkspaceLocationResult,
  RepositoryIdentity,
  SessionSource,
  WorkspaceLocation,
  WorkspaceSource
} from '@shared/types/workspaces.js';
import { isDeviceId } from '@shared/types/devices.js';
import type { CockpitCatalogPort } from './CockpitCoordinator.js';
import type { CockpitOperationStore } from './CockpitOperationStore.js';
import type { DevicePort } from './DevicePort.js';

const DEFAULT_PLAN_TTL_MS = 5 * 60_000;
const MAX_PLANS = 1_000;

export interface CommandPlannerOptions {
  cockpitId: string;
  catalog: CockpitCatalogPort;
  operations: CockpitOperationStore;
  getDevice(deviceId: string): DevicePort | null;
  now?: () => Date;
  planTtlMs?: number;
}

export class CommandPlanner {
  private readonly plans = new Map<string, CockpitPlaceSessionPlan>();
  private readonly now: () => Date;
  private readonly planTtlMs: number;

  constructor(private readonly options: CommandPlannerOptions) {
    if (!isDeviceId(options.cockpitId)) throw new Error('Command Planner Cockpit ID is invalid.');
    this.now = options.now ?? (() => new Date());
    this.planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
  }

  async planPlacement(intent: CockpitPlaceSessionIntent): Promise<CockpitPlaceSessionPlan> {
    validatePlacementIntent(intent);
    const catalog = this.options.catalog.snapshot();
    const workspace = catalog.workspaces.find((candidate) => candidate.id === intent.workspaceId);
    if (!workspace || workspace.archivedAt) throw new Error('Destination Workspace is unavailable.');
    const device = this.options.getDevice(intent.targetDeviceId);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const descriptor = device?.status.descriptor ?? null;
    if (!device) blockers.push('The selected Device is unknown or disabled.');
    else if (device.status.state !== 'ready') blockers.push('The selected Device is not ready.');

    const snapshot = device && device.status.state === 'ready'
      ? await device.snapshot()
      : null;
    const deviceWorkspace = snapshot?.workspace ?? null;
    if (!deviceWorkspace) blockers.push('The selected Device has no Workspace registry capability.');

    const location = catalog.workspaceLocations.find((candidate) =>
      candidate.workspaceId === workspace.id
      && candidate.checkout.deviceId === intent.targetDeviceId
    );
    let checkout = location && deviceWorkspace
      ? deviceWorkspace.checkouts.find((candidate) => candidate.id === location.checkout.checkoutId)
      : undefined;
    let action: CockpitPlaceSessionPlan['preview']['action'] = 'reuse-location';
    let devicePlan: CockpitPlaceSessionPlan['devicePlan'];
    const sessionId = randomUUID();
    let locationId: WorkspaceLocation['id'] | null = location?.id ?? randomUUID();
    let checkoutId = checkout?.id ?? randomUUID();

    if (intent.sourceMode === 'isolated') {
      action = 'prepare-isolated';
      locationId = null;
      const presence = catalog.projectPresences.find((candidate) =>
        candidate.projectId === workspace.projectId
        && candidate.repository.deviceId === intent.targetDeviceId
      );
      const baseOid = resolvedSourceOid(workspace.source);
      if (!presence) {
        blockers.push('The Project has no Presence on the selected Device. Clone or adopt it first.');
      } else if (!baseOid) {
        blockers.push('The Workspace Source has no exact resolved revision for reproducible isolation.');
      } else if (!device?.workspacePlan) {
        blockers.push('The selected Device cannot plan isolated Session placement.');
      } else if (deviceWorkspace) {
        try {
          devicePlan = await device.workspacePlan({
            kind: 'prepare-isolated-session-source',
            repositoryId: presence.repository.repositoryId,
            checkoutId,
            ownerSessionId: sessionId,
            runMode: preferredRunMode(deviceWorkspace.checkouts, presence.repository.repositoryId),
            baseOid,
            detached: false
          });
          blockers.push(...devicePlan.blockers);
          warnings.push(...devicePlan.warnings);
          checkoutId = devicePlan.intent.checkoutId;
        } catch (error) {
          blockers.push(error instanceof Error ? error.message : String(error));
        }
      }
      checkout = undefined;
    } else if (!location || !checkout || checkout.lifecycle !== 'ready') {
      action = 'prepare-location';
      const presence = catalog.projectPresences.find((candidate) =>
        candidate.projectId === workspace.projectId
        && candidate.repository.deviceId === intent.targetDeviceId
      );
      if (!presence) {
        const branchRef = workspace.source.kind === 'branch' ? workspace.source.localRef : null;
        const identity = branchRef
          && projectCanonicalGitIdentity(catalog.projects, workspace.projectId);
        if (!identity) {
          blockers.push('The Project has no reproducible Git remote and Branch for this Device.');
        } else if (!device?.workspacePlan) {
          blockers.push('The selected Device cannot plan Project cloning.');
        } else if (deviceWorkspace && descriptor) {
          action = 'clone-presence';
          try {
            devicePlan = await device.workspacePlan({
              kind: 'clone-project-presence',
              repositoryId: randomUUID(),
              checkoutId,
              sourceUrl: identity.canonicalUrl,
              runMode: descriptor.platform,
              branchRef,
              identity: structuredClone(identity)
            });
            blockers.push(...devicePlan.blockers);
            warnings.push(...devicePlan.warnings);
            checkoutId = devicePlan.intent.checkoutId;
          } catch (error) {
            blockers.push(error instanceof Error ? error.message : String(error));
          }
        }
      } else if (!device?.workspacePlan) {
        blockers.push('The selected Device cannot plan Workspace placement.');
      } else if (deviceWorkspace) {
        try {
          devicePlan = await device.workspacePlan({
            kind: 'prepare-workspace-location',
            repositoryId: presence.repository.repositoryId,
            checkoutId,
            runMode: preferredRunMode(deviceWorkspace.checkouts, presence.repository.repositoryId),
            source: structuredClone(workspace.source)
          });
          blockers.push(...devicePlan.blockers);
          warnings.push(...devicePlan.warnings);
          checkoutId = devicePlan.intent.checkoutId;
        } catch (error) {
          blockers.push(error instanceof Error ? error.message : String(error));
        }
      }
      checkout = undefined;
    }

    const targetPath = checkout?.path ?? devicePlan?.preview.targetPath ?? '';
    const plannedRunMode = devicePlan && 'runMode' in devicePlan.intent
      ? devicePlan.intent.runMode
      : undefined;
    const plannedWslDistro = devicePlan && 'wslDistro' in devicePlan.intent
      ? devicePlan.intent.wslDistro
      : undefined;
    const runMode = checkout?.runMode ?? plannedRunMode ?? 'linux';
    const wslDistro = checkout?.wslDistro ?? plannedWslDistro;
    const createdAt = this.now();
    const plan: CockpitPlaceSessionPlan = {
      schemaVersion: 1,
      planId: randomUUID(),
      kind: 'place-session',
      intent: structuredClone(intent),
      catalogRevision: catalog.revision,
      preview: {
        action,
        deviceName: descriptor?.name ?? intent.targetDeviceId,
        sessionId,
        locationId,
        checkoutId,
        targetPath,
        runMode,
        ...(wslDistro ? { wslDistro } : {}),
        source: structuredClone(workspace.source)
      },
      acknowledgements: warnings.map((warning, index) => ({
        id: `warning-${index + 1}`,
        label: warning,
        required: true
      })),
      executable: blockers.length === 0 && Boolean(targetPath),
      blockers,
      warnings,
      createdAt: createdAt.toISOString(),
      expiresAt: devicePlan?.expiresAt
        ?? new Date(createdAt.getTime() + this.planTtlMs).toISOString(),
      ...(devicePlan ? { devicePlan: structuredClone(devicePlan) } : {})
    };
    this.remember(plan);
    return structuredClone(plan);
  }

  async executePlacement(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitPlaceSessionOperation> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error('Cockpit plan is unknown or expired.');
    if (this.now().getTime() > Date.parse(plan.expiresAt)) {
      this.plans.delete(planId);
      throw new Error('Cockpit plan expired; run preflight again.');
    }
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Cockpit plan is blocked.');
    const missing = plan.acknowledgements
      .filter((item) => item.required && !acknowledgements.includes(item.id));
    if (missing.length > 0) throw new Error('Required placement acknowledgements are missing.');
    if (this.options.catalog.snapshot().revision !== plan.catalogRevision) {
      throw new Error('Cockpit Catalog changed; run placement preflight again.');
    }
    const device = this.options.getDevice(plan.intent.targetDeviceId);
    if (!device || device.status.state !== 'ready') throw new Error('The selected Device is not ready.');
    if (!device.createSession || !device.startSession) {
      throw new Error('The selected Device cannot create placed Sessions.');
    }

    const operationId = randomUUID();
    await this.options.operations.create({ operationId, planId, kind: plan.kind });
    await this.options.operations.update(operationId, {
      state: 'running',
      phase: 'prepare-source',
      progress: 10,
      message: 'Preparing the Session source.'
    });
    try {
      let checkout: CheckoutRecord;
      let catalogRevision = plan.catalogRevision;
      if (plan.devicePlan) {
        if (!device.workspaceExecute) throw new Error('The Device cannot prepare a Workspace Location.');
        const commandId = randomUUID();
        const command: DeviceCommandEnvelope<DeviceWorkspaceIntent> = {
          schemaVersion: 1,
          cockpitId: this.options.cockpitId,
          commandId,
          targetDeviceId: plan.intent.targetDeviceId,
          actorClientId: 'electron-cockpit',
          expectedEntityVersions: {
            'device-workspace': plan.devicePlan.expectedWorkspaceRevision
          },
          capabilityRevision: plan.devicePlan.capabilityRevision,
          planToken: plan.devicePlan.planToken,
          planExpiresAt: plan.devicePlan.expiresAt,
          intent: structuredClone(plan.devicePlan.intent)
        };
        await this.options.operations.update(operationId, {
          childCommands: [{ deviceId: command.targetDeviceId, commandId }],
          phase: 'prepare-checkout',
          progress: 25,
          message: 'Preparing the Device Checkout.'
        });
        const receipt = await device.workspaceExecute(command);
        checkout = preparedCheckout(receipt.result);
        if (plan.devicePlan.intent.kind === 'prepare-workspace-location') {
          if (!plan.preview.locationId) throw new Error('Ordinary Workspace placement has no Location identity.');
          const linked = await this.options.catalog.execute({
            expectedRevision: catalogRevision,
            mutations: [{
              type: 'location.link',
              location: {
                id: plan.preview.locationId,
                workspaceId: plan.intent.workspaceId,
                checkout: {
                  deviceId: plan.intent.targetDeviceId,
                  checkoutId: checkout.id
                },
                state: 'available'
              }
            }]
          });
          catalogRevision = linked.snapshot.revision;
        } else if (plan.devicePlan.intent.kind === 'clone-project-presence') {
          if (!plan.preview.locationId) throw new Error('Cloned Workspace placement has no Location identity.');
          const linked = await this.options.catalog.execute({
            expectedRevision: catalogRevision,
            mutations: [
              {
                type: 'presence.link',
                projectId: workspaceProjectId(plan, this.options.catalog),
                repository: {
                  deviceId: plan.intent.targetDeviceId,
                  repositoryId: plan.devicePlan.intent.repositoryId
                },
                adoptedFromEvidence: structuredClone(plan.devicePlan.intent.identity)
              },
              {
                type: 'location.link',
                location: {
                  id: plan.preview.locationId,
                  workspaceId: plan.intent.workspaceId,
                  checkout: {
                    deviceId: plan.intent.targetDeviceId,
                    checkoutId: checkout.id
                  },
                  state: 'available'
                }
              }
            ]
          });
          catalogRevision = linked.snapshot.revision;
        }
      } else {
        const current = await device.snapshot();
        checkout = requiredReadyCheckout(current.workspace?.checkouts ?? [], plan.preview.checkoutId);
      }

      await this.options.operations.update(operationId, {
        phase: 'create-session',
        progress: 60,
        message: 'Creating the durable Session record.'
      });
      const session = await device.createSession({
        sessionId: plan.preview.sessionId,
        draft: {
          ...structuredClone(plan.intent.session),
          ...(plan.intent.successorOf ? {
            originSessionRef: structuredClone(plan.intent.successorOf),
            ...(plan.intent.successorOf.deviceId === plan.intent.targetDeviceId
              ? { originSessionId: plan.intent.successorOf.sessionId }
              : {})
          } : {}),
          cwd: checkout.path,
          runMode: checkout.runMode,
          ...(checkout.wslDistro ? { wslDistro: checkout.wslDistro } : {}),
          source: sessionSource(plan, checkout)
        }
      });
      const grouped = await this.options.catalog.execute({
        expectedRevision: catalogRevision,
        mutations: [{
          type: 'session.regroup',
          sessionRef: { deviceId: plan.intent.targetDeviceId, sessionId: session.id },
          workspaceId: plan.intent.workspaceId
        }]
      });
      catalogRevision = grouped.snapshot.revision;
      void catalogRevision;

      let terminalRef: CockpitPlaceSessionResult['terminalRef'] = null;
      let startError: string | undefined;
      try {
        await this.options.operations.update(operationId, {
          phase: 'start-session',
          progress: 85,
          message: 'Starting the Session Runtime.'
        });
        const terminal = await device.startSession(session.id);
        terminalRef = {
          deviceId: plan.intent.targetDeviceId,
          terminalId: terminal.terminalId
        };
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
      const result: CockpitPlaceSessionResult = {
        sessionRef: { deviceId: plan.intent.targetDeviceId, sessionId: session.id },
        terminalRef,
        session,
        checkout: { deviceId: plan.intent.targetDeviceId, checkoutId: checkout.id },
        locationId: plan.preview.locationId,
        started: Boolean(terminalRef),
        ...(startError ? { startError } : {})
      };
      const operation = await this.options.operations.update(operationId, {
        state: startError ? 'needs-attention' : 'succeeded',
        phase: startError ? 'start-failed' : 'complete',
        progress: 100,
        message: startError
          ? 'The Session record is safe but its Runtime did not start.'
          : 'Session placement completed.',
        result
      });
      this.plans.delete(planId);
      return operation as CockpitPlaceSessionOperation;
    } catch (error) {
      await this.options.operations.update(operationId, {
        state: 'needs-attention',
        phase: 'recover',
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  getOperation(operationId: string): CockpitPlaceSessionOperation | null {
    return this.options.operations.get(operationId) as CockpitPlaceSessionOperation | null;
  }

  private remember(plan: CockpitPlaceSessionPlan): void {
    for (const [id, existing] of this.plans) {
      if (this.now().getTime() > Date.parse(existing.expiresAt)) this.plans.delete(id);
    }
    if (this.plans.size >= MAX_PLANS) {
      const oldest = [...this.plans.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) this.plans.delete(oldest.planId);
    }
    this.plans.set(plan.planId, structuredClone(plan));
  }
}

function validatePlacementIntent(intent: CockpitPlaceSessionIntent): void {
  if (
    intent?.kind !== 'place-session'
    || !isDeviceId(intent.workspaceId)
    || !isDeviceId(intent.targetDeviceId)
    || !['shared', 'isolated'].includes(intent.sourceMode)
    || !intent.session?.name?.trim()
    || !intent.session.launch
    || (intent.successorOf !== undefined && (
      !isDeviceId(intent.successorOf.deviceId)
      || !intent.successorOf.sessionId?.trim()
    ))
  ) throw new Error('Session placement intent is invalid.');
}

function preferredRunMode(checkouts: CheckoutRecord[], repositoryId: string): CheckoutRecord['runMode'] {
  return checkouts.find((checkout) => checkout.repositoryId === repositoryId)?.runMode ?? 'linux';
}

function resolvedSourceOid(source: WorkspaceSource): string | null {
  return source.kind === 'revision' ? source.oid : source.lastResolved?.oid ?? null;
}

function projectCanonicalGitIdentity(
  projects: CockpitCatalogSnapshot['projects'],
  projectId: string
): Extract<RepositoryIdentity, { kind: 'git' }> | null {
  const identity = projects.find((project) => project.id === projectId)?.canonicalRepository;
  return identity?.kind === 'git' ? structuredClone(identity) : null;
}

function workspaceProjectId(
  plan: CockpitPlaceSessionPlan,
  catalog: CockpitCatalogPort
): string {
  const workspace = catalog.snapshot().workspaces.find((candidate) =>
    candidate.id === plan.intent.workspaceId
  );
  if (!workspace) throw new Error('Destination Workspace disappeared during placement.');
  return workspace.projectId;
}

function sessionSource(plan: CockpitPlaceSessionPlan, checkout: CheckoutRecord): SessionSource {
  if (plan.devicePlan?.intent.kind === 'prepare-isolated-session-source') {
    const { baseOid, branchRef } = plan.devicePlan.intent;
    return {
      kind: 'isolated-worktree',
      checkoutId: checkout.id,
      base: { oid: baseOid, ...(branchRef ? { ref: branchRef } : {}) },
      ...(branchRef ? { generatedBranch: branchRef } : {}),
      ownership: 'session'
    };
  }
  if (!plan.preview.locationId) {
    throw new Error('Ordinary Workspace placement has no Location identity.');
  }
  return {
    kind: 'workspace-location',
    checkoutId: checkout.id,
    locationCorrelation: plan.preview.locationId
  };
}

function preparedCheckout(value: unknown): CheckoutRecord {
  const result = value as PreparedWorkspaceLocationResult | undefined;
  if (!result?.checkout || result.checkout.lifecycle !== 'ready') {
    throw new Error('Device placement receipt has no ready Checkout.');
  }
  return structuredClone(result.checkout);
}

function requiredReadyCheckout(checkouts: CheckoutRecord[], checkoutId: string): CheckoutRecord {
  const checkout = checkouts.find((candidate) => candidate.id === checkoutId);
  if (!checkout || checkout.lifecycle !== 'ready') {
    throw new Error('Workspace Location Checkout is no longer available.');
  }
  return structuredClone(checkout);
}
