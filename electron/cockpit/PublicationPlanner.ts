import { randomUUID } from 'node:crypto';

import type { DeviceCommandEnvelope, DeviceOperationReceipt } from '@shared/types/commands.js';
import { isDeviceId } from '@shared/types/devices.js';
import type {
  CockpitPublishProjectIntent,
  CockpitPublishProjectOperation,
  CockpitPublishProjectPlan,
  CockpitPublishProjectResult,
  CreatedGitHubRepository,
  CreateGitHubRepositoryIntent,
  GitHubRepositoryOperationReceipt,
  GitHubRepositoryPlan
} from '@shared/types/providers.js';
import type { DeviceWorkspaceIntent, DeviceWorkspacePlan } from '@shared/types/workspaces.js';
import type { CockpitCatalogPort } from './CockpitCoordinator.js';
import type { CockpitOperationStore } from './CockpitOperationStore.js';
import type { DevicePort } from './DevicePort.js';

const MAX_PLANS = 1_000;

export interface PublicationPlannerOptions {
  cockpitId: string;
  catalog: CockpitCatalogPort;
  operations: CockpitOperationStore;
  getDevice(deviceId: string): DevicePort | null;
  now?: () => Date;
}

/** Provider creation and Git publication remain separate, durable receipts. */
export class PublicationPlanner {
  private readonly plans = new Map<string, CockpitPublishProjectPlan>();
  private readonly now: () => Date;

  constructor(private readonly options: PublicationPlannerOptions) {
    if (!isDeviceId(options.cockpitId)) throw new Error('Publication Planner Cockpit ID is invalid.');
    this.now = options.now ?? (() => new Date());
  }

  async plan(intent: CockpitPublishProjectIntent): Promise<CockpitPublishProjectPlan> {
    validateIntent(intent);
    const catalog = this.options.catalog.snapshot();
    const workspace = catalog.workspaces.find((candidate) => candidate.id === intent.workspaceId);
    if (!workspace || workspace.archivedAt) throw new Error('Publication Workspace is unavailable.');
    if (workspace.source.kind !== 'branch') {
      throw new Error('Initial Project publication supports Branch Workspaces only.');
    }
    const project = catalog.projects.find((candidate) => candidate.id === workspace.projectId);
    if (!project || project.archivedAt) throw new Error('Publication Project is unavailable.');
    if (project.canonicalRepository?.kind === 'git') {
      throw new Error('Project already has a published Git identity.');
    }
    const location = catalog.workspaceLocations.find((candidate) =>
      candidate.workspaceId === workspace.id
      && candidate.checkout.deviceId === intent.sourceDeviceId
      && candidate.state === 'available'
    );
    if (!location) throw new Error('Publication requires an available Location on the source Device.');
    const device = this.options.getDevice(intent.sourceDeviceId);
    if (!device || device.status.state !== 'ready') throw new Error('Publication Device is not ready.');
    if (!device.githubProviderPlan || !device.workspacePlan) {
      throw new Error('Publication Device lacks GitHub or Git publication planning capability.');
    }
    const remote = normalizedRemote(intent.remote);
    const providerPlan = await device.githubProviderPlan({
      kind: 'create-github-repository',
      owner: intent.owner,
      name: intent.name,
      visibility: intent.visibility,
      ...(intent.description?.trim() ? { description: intent.description.trim() } : {})
    });
    const anticipatedSshUrl = `git@github.com:${providerPlan.intent.owner}/${providerPlan.intent.name}.git`;
    const devicePlan = await device.workspacePlan({
      kind: 'publish-new-remote-branch',
      checkoutId: location.checkout.checkoutId,
      remote,
      remoteUrl: anticipatedSshUrl,
      branchRef: workspace.source.localRef
    });
    const localOid = devicePlan.intent.kind === 'publish-new-remote-branch'
      ? devicePlan.intent.expectedLocalOid
      : undefined;
    if (!localOid) throw new Error('Publication Device plan has no exact local revision.');
    const blockers = [...providerPlan.blockers, ...devicePlan.blockers];
    const warnings = [...providerPlan.warnings, ...devicePlan.warnings];
    const createdAt = this.now();
    const plan: CockpitPublishProjectPlan = {
      schemaVersion: 1,
      planId: randomUUID(),
      kind: 'publish-project',
      intent: structuredClone({ ...intent, remote }),
      catalogRevision: catalog.revision,
      projectVersion: project.version,
      preview: {
        projectName: project.name,
        workspaceName: workspace.name,
        deviceName: device.status.descriptor?.name ?? device.deviceId,
        branchRef: workspace.source.localRef,
        remote,
        localOid,
        owner: providerPlan.intent.owner,
        name: providerPlan.intent.name,
        visibility: providerPlan.intent.visibility,
        url: providerPlan.preview.url
      },
      acknowledgements: warnings.map((warning, index) => ({
        id: `warning-${index + 1}`,
        label: warning,
        required: true
      })),
      executable: blockers.length === 0,
      blockers,
      warnings,
      createdAt: createdAt.toISOString(),
      expiresAt: earlierExpiry(providerPlan, devicePlan),
      providerPlan: structuredClone(providerPlan),
      devicePlan: structuredClone(devicePlan)
    };
    this.remember(plan);
    return structuredClone(plan);
  }

  async execute(planId: string, acknowledgements: string[]): Promise<CockpitPublishProjectOperation> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error('Publication plan is unknown or expired.');
    if (this.now().getTime() > Date.parse(plan.expiresAt)) {
      this.plans.delete(planId);
      throw new Error('Publication plan expired; run preflight again.');
    }
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Publication plan is blocked.');
    const missing = plan.acknowledgements.filter((item) =>
      item.required && !acknowledgements.includes(item.id)
    );
    if (missing.length > 0) throw new Error('Required publication acknowledgements are missing.');
    if (this.options.catalog.snapshot().revision !== plan.catalogRevision) {
      throw new Error('Cockpit Catalog changed; run publication preflight again.');
    }
    const device = this.options.getDevice(plan.intent.sourceDeviceId);
    if (!device || device.status.state !== 'ready') throw new Error('Publication Device is not ready.');
    if (!device.githubProviderExecute || !device.workspaceExecute) {
      throw new Error('Publication Device lacks execution capability.');
    }
    const operationId = randomUUID();
    const providerCommand = providerEnvelope(this.options.cockpitId, plan.providerPlan);
    const pushCommand = workspaceEnvelope(this.options.cockpitId, plan.devicePlan);
    await this.options.operations.create({ operationId, planId, kind: plan.kind });
    await this.options.operations.update(operationId, {
      state: 'running',
      phase: 'create-remote',
      progress: 15,
      message: `Creating ${plan.preview.owner}/${plan.preview.name} on GitHub.`,
      childCommands: [
        { deviceId: providerCommand.targetDeviceId, commandId: providerCommand.commandId },
        { deviceId: pushCommand.targetDeviceId, commandId: pushCommand.commandId }
      ]
    });
    let phase: 'provider' | 'identity' | 'push' = 'provider';
    let providerReceipt: GitHubRepositoryOperationReceipt | null = null;
    let repository: CreatedGitHubRepository | null = null;
    try {
      providerReceipt = await device.githubProviderExecute(providerCommand);
      repository = providerReceipt.result ?? null;
      if (!repository || repository.owner !== plan.preview.owner || repository.name !== plan.preview.name) {
        throw new Error('GitHub repository receipt does not match the publication plan.');
      }
      phase = 'identity';
      await this.options.operations.update(operationId, {
        phase: 'record-identity',
        progress: 45,
        message: 'Recording the new Project repository identity.'
      });
      const workspace = this.options.catalog.snapshot().workspaces.find((candidate) =>
        candidate.id === plan.intent.workspaceId
      );
      if (!workspace) throw new Error('Publication Workspace disappeared.');
      await this.options.catalog.execute({
        expectedRevision: plan.catalogRevision,
        mutations: [{
          type: 'project.repository',
          projectId: workspace.projectId,
          expectedVersion: plan.projectVersion,
          canonicalRepository: {
            kind: 'git',
            canonicalUrl: repository.url,
            provider: 'github',
            providerRepositoryId: repository.providerRepositoryId
          }
        }]
      });
      phase = 'push';
      if (
        plan.devicePlan.intent.kind !== 'publish-new-remote-branch'
        || plan.devicePlan.intent.remoteUrl !== repository.sshUrl
      ) throw new Error('GitHub SSH URL differs from the immutable publication plan.');
      await this.options.operations.update(operationId, {
        phase: 'push-branch',
        progress: 70,
        message: `Publishing ${plan.preview.branchRef} from ${plan.preview.deviceName}.`
      });
      const pushReceipt = await device.workspaceExecute(pushCommand);
      const result: CockpitPublishProjectResult = {
        projectId: workspace.projectId,
        repository,
        providerReceipt,
        pushReceipt,
        pushed: true
      };
      const operation = await this.options.operations.update(operationId, {
        state: 'succeeded',
        phase: 'complete',
        progress: 100,
        message: 'Project publication completed.',
        result
      });
      this.plans.delete(planId);
      return operation as CockpitPublishProjectOperation;
    } catch (error) {
      const partial = providerReceipt && repository ? {
        projectId: workspaceProjectId(plan, this.options.catalog),
        repository,
        providerReceipt,
        pushReceipt: null,
        pushed: false
      } satisfies CockpitPublishProjectResult : undefined;
      await this.options.operations.update(operationId, {
        state: 'needs-attention',
        phase: phase === 'provider'
          ? 'provider-failed'
          : phase === 'identity' ? 'identity-failed' : 'push-failed',
        progress: phase === 'provider' ? 15 : phase === 'identity' ? 45 : 70,
        message: error instanceof Error ? error.message : String(error),
        ...(partial ? { result: partial } : {})
      });
      throw error;
    }
  }

  getOperation(operationId: string): CockpitPublishProjectOperation | null {
    return this.options.operations.get(operationId) as CockpitPublishProjectOperation | null;
  }

  private remember(plan: CockpitPublishProjectPlan): void {
    for (const [id, previous] of this.plans) {
      if (this.now().getTime() > Date.parse(previous.expiresAt)) this.plans.delete(id);
    }
    if (this.plans.size >= MAX_PLANS) {
      const oldest = [...this.plans.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) this.plans.delete(oldest.planId);
    }
    this.plans.set(plan.planId, structuredClone(plan));
  }
}

function validateIntent(intent: CockpitPublishProjectIntent): void {
  if (
    intent?.kind !== 'publish-project'
    || !isDeviceId(intent.workspaceId)
    || !isDeviceId(intent.sourceDeviceId)
    || !intent.owner?.trim()
    || !intent.name?.trim()
    || !['private', 'public'].includes(intent.visibility)
  ) throw new Error('Project publication intent is invalid.');
}

function normalizedRemote(value: string | undefined): string {
  const remote = value?.trim() || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remote)) {
    throw new Error('Project publication remote name is invalid.');
  }
  return remote;
}

function earlierExpiry(provider: GitHubRepositoryPlan, device: DeviceWorkspacePlan): string {
  return Date.parse(provider.expiresAt) <= Date.parse(device.expiresAt)
    ? provider.expiresAt
    : device.expiresAt;
}

function providerEnvelope(
  cockpitId: string,
  plan: GitHubRepositoryPlan
): DeviceCommandEnvelope<CreateGitHubRepositoryIntent> {
  return {
    schemaVersion: 1,
    cockpitId,
    commandId: randomUUID(),
    targetDeviceId: plan.targetDeviceId,
    actorClientId: 'electron-cockpit',
    expectedEntityVersions: {},
    capabilityRevision: plan.capabilityRevision,
    planToken: plan.planToken,
    planExpiresAt: plan.expiresAt,
    intent: structuredClone(plan.intent)
  };
}

function workspaceEnvelope(
  cockpitId: string,
  plan: DeviceWorkspacePlan
): DeviceCommandEnvelope<DeviceWorkspaceIntent> {
  return {
    schemaVersion: 1,
    cockpitId,
    commandId: randomUUID(),
    targetDeviceId: plan.targetDeviceId,
    actorClientId: 'electron-cockpit',
    expectedEntityVersions: { 'device-workspace': plan.expectedWorkspaceRevision },
    capabilityRevision: plan.capabilityRevision,
    planToken: plan.planToken,
    planExpiresAt: plan.expiresAt,
    intent: structuredClone(plan.intent)
  };
}

function workspaceProjectId(
  plan: CockpitPublishProjectPlan,
  catalog: CockpitCatalogPort
): string {
  const workspace = catalog.snapshot().workspaces.find((candidate) =>
    candidate.id === plan.intent.workspaceId
  );
  if (!workspace) throw new Error('Publication Workspace disappeared.');
  return workspace.projectId;
}
