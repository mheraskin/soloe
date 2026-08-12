import { randomUUID } from 'node:crypto';

import type { DeviceCommandEnvelope } from '@shared/types/commands.js';
import { isDeviceId } from '@shared/types/devices.js';
import type {
  CockpitAlignWorkspaceIntent,
  CockpitAlignWorkspaceOperation,
  CockpitAlignWorkspacePlan,
  CockpitAlignWorkspaceResult,
  DeviceWorkspaceIntent,
  DeviceWorkspacePlan
} from '@shared/types/workspaces.js';
import type { CockpitCatalogPort } from './CockpitCoordinator.js';
import type { CockpitOperationStore } from './CockpitOperationStore.js';
import type { DevicePort } from './DevicePort.js';

const MAX_PLANS = 1_000;

export interface AlignmentPlannerOptions {
  cockpitId: string;
  catalog: CockpitCatalogPort;
  operations: CockpitOperationStore;
  getDevice(deviceId: string): DevicePort | null;
  now?: () => Date;
}

/** Coordinates an additive push → fetch → fast-forward saga across two Devices. */
export class AlignmentPlanner {
  private readonly plans = new Map<string, CockpitAlignWorkspacePlan>();
  private readonly now: () => Date;

  constructor(private readonly options: AlignmentPlannerOptions) {
    if (!isDeviceId(options.cockpitId)) throw new Error('Alignment Planner Cockpit ID is invalid.');
    this.now = options.now ?? (() => new Date());
  }

  async plan(intent: CockpitAlignWorkspaceIntent): Promise<CockpitAlignWorkspacePlan> {
    validateIntent(intent);
    const catalog = this.options.catalog.snapshot();
    const workspace = catalog.workspaces.find((candidate) => candidate.id === intent.workspaceId);
    if (!workspace || workspace.archivedAt) throw new Error('Alignment Workspace is unavailable.');
    if (workspace.source.kind !== 'branch') {
      throw new Error('Initial Workspace alignment supports Branch Sources only.');
    }
    const sourceLocation = catalog.workspaceLocations.find((location) =>
      location.workspaceId === workspace.id
      && location.checkout.deviceId === intent.sourceDeviceId
      && location.state === 'available'
    );
    const targetLocation = catalog.workspaceLocations.find((location) =>
      location.workspaceId === workspace.id
      && location.checkout.deviceId === intent.targetDeviceId
      && location.state === 'available'
    );
    if (!sourceLocation || !targetLocation) {
      throw new Error('Alignment requires available ordinary Locations on both Devices.');
    }
    const sourceDevice = requiredReadyDevice(this.options.getDevice(intent.sourceDeviceId), 'source');
    const targetDevice = requiredReadyDevice(this.options.getDevice(intent.targetDeviceId), 'target');
    if (!sourceDevice.workspacePlan || !targetDevice.workspacePlan) {
      throw new Error('Both Devices must support Workspace alignment planning.');
    }
    const remote = normalizedRemote(intent.remote);
    const sourceDevicePlan = await sourceDevice.workspacePlan({
      kind: 'push-workspace-branch',
      checkoutId: sourceLocation.checkout.checkoutId,
      remote,
      branchRef: workspace.source.localRef
    });
    const sourceOid = sourceDevicePlan.intent.kind === 'push-workspace-branch'
      ? sourceDevicePlan.intent.expectedLocalOid
      : undefined;
    if (!sourceOid) throw new Error('Source Device plan has no exact local revision.');
    const targetDevicePlan = await targetDevice.workspacePlan({
      kind: 'fetch-fast-forward-workspace-branch',
      checkoutId: targetLocation.checkout.checkoutId,
      remote,
      branchRef: workspace.source.localRef,
      targetOid: sourceOid,
      expectedRemoteOid: sourceOid
    });
    const targetOid = targetDevicePlan.intent.kind === 'fetch-fast-forward-workspace-branch'
      ? targetDevicePlan.intent.expectedHeadOid
      : undefined;
    if (!targetOid) throw new Error('Target Device plan has no exact local revision.');
    const blockers = [...sourceDevicePlan.blockers, ...targetDevicePlan.blockers];
    if (
      sourceDevicePlan.remoteEvidence?.remoteUrl
      && targetDevicePlan.remoteEvidence?.remoteUrl
      && sourceDevicePlan.remoteEvidence.remoteUrl !== targetDevicePlan.remoteEvidence.remoteUrl
    ) blockers.push('The two Device Locations do not identify the same remote URL.');
    const warnings = [...sourceDevicePlan.warnings, ...targetDevicePlan.warnings];
    const createdAt = this.now();
    const plan: CockpitAlignWorkspacePlan = {
      schemaVersion: 1,
      planId: randomUUID(),
      kind: 'align-workspace',
      intent: structuredClone({ ...intent, remote }),
      catalogRevision: catalog.revision,
      preview: {
        workspaceName: workspace.name,
        branchRef: workspace.source.localRef,
        remote,
        sourceDeviceName: sourceDevice.status.descriptor?.name ?? sourceDevice.deviceId,
        targetDeviceName: targetDevice.status.descriptor?.name ?? targetDevice.deviceId,
        sourceOid,
        targetOid,
        remoteOid: sourceDevicePlan.remoteEvidence?.remoteOid ?? null
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
      expiresAt: earlierExpiry(sourceDevicePlan, targetDevicePlan),
      sourceDevicePlan: structuredClone(sourceDevicePlan),
      targetDevicePlan: structuredClone(targetDevicePlan)
    };
    this.remember(plan);
    return structuredClone(plan);
  }

  async execute(planId: string, acknowledgements: string[]): Promise<CockpitAlignWorkspaceOperation> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error('Alignment plan is unknown or expired.');
    if (this.now().getTime() > Date.parse(plan.expiresAt)) {
      this.plans.delete(planId);
      throw new Error('Alignment plan expired; run preflight again.');
    }
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Alignment plan is blocked.');
    const missing = plan.acknowledgements.filter((item) =>
      item.required && !acknowledgements.includes(item.id)
    );
    if (missing.length > 0) throw new Error('Required alignment acknowledgements are missing.');
    if (this.options.catalog.snapshot().revision !== plan.catalogRevision) {
      throw new Error('Cockpit Catalog changed; run alignment preflight again.');
    }
    const source = requiredReadyDevice(this.options.getDevice(plan.intent.sourceDeviceId), 'source');
    const target = requiredReadyDevice(this.options.getDevice(plan.intent.targetDeviceId), 'target');
    if (!source.workspaceExecute || !target.workspaceExecute) {
      throw new Error('Both Devices must support Workspace alignment execution.');
    }
    const operationId = randomUUID();
    const sourceCommand = command(this.options.cockpitId, plan.sourceDevicePlan);
    const targetCommand = command(this.options.cockpitId, plan.targetDevicePlan);
    await this.options.operations.create({ operationId, planId, kind: plan.kind });
    await this.options.operations.update(operationId, {
      state: 'running',
      phase: 'publish-source',
      progress: 15,
      message: `Publishing ${plan.preview.sourceOid} from ${plan.preview.sourceDeviceName}.`,
      childCommands: [
        { deviceId: sourceCommand.targetDeviceId, commandId: sourceCommand.commandId },
        { deviceId: targetCommand.targetDeviceId, commandId: targetCommand.commandId }
      ]
    });
    let phase: 'source' | 'target' = 'source';
    try {
      const sourceReceipt = await source.workspaceExecute(sourceCommand);
      phase = 'target';
      await this.options.operations.update(operationId, {
        phase: 'align-target',
        progress: 60,
        message: `Fetching and fast-forwarding ${plan.preview.targetDeviceName}.`
      });
      const targetReceipt = await target.workspaceExecute(targetCommand);
      const result: CockpitAlignWorkspaceResult = { sourceReceipt, targetReceipt };
      const operation = await this.options.operations.update(operationId, {
        state: 'succeeded',
        phase: 'complete',
        progress: 100,
        message: 'Workspace alignment completed.',
        result
      });
      this.plans.delete(planId);
      return operation as CockpitAlignWorkspaceOperation;
    } catch (error) {
      await this.options.operations.update(operationId, {
        state: 'needs-attention',
        phase: phase === 'source' ? 'source-failed' : 'target-failed',
        progress: phase === 'source' ? 15 : 60,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  getOperation(operationId: string): CockpitAlignWorkspaceOperation | null {
    return this.options.operations.get(operationId) as CockpitAlignWorkspaceOperation | null;
  }

  private remember(plan: CockpitAlignWorkspacePlan): void {
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

function validateIntent(intent: CockpitAlignWorkspaceIntent): void {
  if (
    intent?.kind !== 'align-workspace'
    || !isDeviceId(intent.workspaceId)
    || !isDeviceId(intent.sourceDeviceId)
    || !isDeviceId(intent.targetDeviceId)
    || intent.sourceDeviceId === intent.targetDeviceId
  ) throw new Error('Workspace alignment intent is invalid.');
}

function requiredReadyDevice(device: DevicePort | null, role: string): DevicePort {
  if (!device || device.status.state !== 'ready') {
    throw new Error(`The alignment ${role} Device is not ready.`);
  }
  return device;
}

function normalizedRemote(value: string | undefined): string {
  const remote = value?.trim() || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remote)) {
    throw new Error('Workspace alignment remote name is invalid.');
  }
  return remote;
}

function earlierExpiry(left: DeviceWorkspacePlan, right: DeviceWorkspacePlan): string {
  return Date.parse(left.expiresAt) <= Date.parse(right.expiresAt) ? left.expiresAt : right.expiresAt;
}

function command(
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
