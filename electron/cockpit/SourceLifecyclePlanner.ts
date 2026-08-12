import { randomUUID } from 'node:crypto';

import type { DeviceCommandEnvelope } from '@shared/types/commands.js';
import { isDeviceId } from '@shared/types/devices.js';
import type { Session } from '@shared/types/sessions.js';
import type {
  CockpitSessionSourceLifecycleIntent,
  CockpitSessionSourceLifecycleOperation,
  CockpitSessionSourceLifecyclePlan,
  CockpitSessionSourceLifecycleResult,
  DeviceWorkspaceIntent,
  DeviceWorkspacePlan
} from '@shared/types/workspaces.js';
import type { CockpitCatalogPort } from './CockpitCoordinator.js';
import type { CockpitOperationStore } from './CockpitOperationStore.js';
import type { DevicePort } from './DevicePort.js';

const MAX_PLANS = 1_000;

export interface SourceLifecyclePlannerOptions {
  cockpitId: string;
  catalog: CockpitCatalogPort;
  operations: CockpitOperationStore;
  getDevice(deviceId: string): DevicePort | null;
  now?: () => Date;
}

export class SourceLifecyclePlanner {
  private readonly plans = new Map<string, CockpitSessionSourceLifecyclePlan>();
  private readonly now: () => Date;

  constructor(private readonly options: SourceLifecyclePlannerOptions) {
    if (!isDeviceId(options.cockpitId)) throw new Error('Source Lifecycle Planner Cockpit ID is invalid.');
    this.now = options.now ?? (() => new Date());
  }

  async plan(
    intent: CockpitSessionSourceLifecycleIntent
  ): Promise<CockpitSessionSourceLifecyclePlan> {
    validateIntent(intent);
    const catalog = this.options.catalog.snapshot();
    const device = this.options.getDevice(intent.sessionRef.deviceId);
    if (!device || device.status.state !== 'ready') throw new Error('Session Device is not ready.');
    if (!device.workspacePlan) throw new Error('Session Device lacks source lifecycle planning.');
    const snapshot = await device.snapshot();
    const session = [...snapshot.sessions, ...snapshot.archivedSessions].find((candidate) =>
      candidate.id === intent.sessionRef.sessionId
    );
    if (!session || session.source?.kind !== 'isolated-worktree') {
      throw new Error('Session has no isolated source to promote or clean up.');
    }
    const checkout = snapshot.workspace?.checkouts.find((candidate) =>
      candidate.id === session.source!.checkoutId
    );
    if (!checkout) throw new Error('Session isolated Checkout is unavailable.');
    const membership = catalog.sessionMemberships.find((candidate) =>
      candidate.sessionRef.deviceId === intent.sessionRef.deviceId
      && candidate.sessionRef.sessionId === intent.sessionRef.sessionId
    );
    let workspaceId: string | null = null;
    let locationId: string | null = null;
    let devicePlan: DeviceWorkspacePlan;
    const blockers: string[] = [];
    if (intent.kind === 'promote-isolated-source') {
      workspaceId = membership?.workspaceId ?? null;
      if (!workspaceId || !catalog.workspaces.some((workspace) => workspace.id === workspaceId)) {
        blockers.push('Promotion requires this Session to belong to a Workspace.');
      }
      if (workspaceId && catalog.workspaceLocations.some((location) =>
        location.workspaceId === workspaceId
        && location.checkout.deviceId === intent.sessionRef.deviceId
      )) blockers.push('This Workspace already has an ordinary Location on the Session Device.');
      locationId = randomUUID();
      devicePlan = await device.workspacePlan({
        kind: 'promote-isolated-checkout',
        checkoutId: checkout.id,
        expectedOwnerSessionId: session.id
      });
    } else {
      devicePlan = await device.workspacePlan({
        kind: 'cleanup-isolated-checkout',
        checkoutId: checkout.id,
        expectedOwnerSessionId: session.id
      });
    }
    blockers.push(...devicePlan.blockers);
    const warnings = [...devicePlan.warnings];
    const createdAt = this.now();
    const plan: CockpitSessionSourceLifecyclePlan = {
      schemaVersion: 1,
      planId: randomUUID(),
      kind: 'session-source-lifecycle',
      intent: structuredClone(intent),
      catalogRevision: catalog.revision,
      preview: {
        deviceName: device.status.descriptor?.name ?? device.deviceId,
        sessionName: session.name,
        checkoutId: checkout.id,
        checkoutPath: checkout.path,
        workspaceId,
        locationId,
        sessionVersion: session.version ?? 1
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
      expiresAt: devicePlan.expiresAt,
      devicePlan: structuredClone(devicePlan)
    };
    this.remember(plan);
    return structuredClone(plan);
  }

  async execute(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitSessionSourceLifecycleOperation> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error('Session source lifecycle plan is unknown or expired.');
    if (this.now().getTime() > Date.parse(plan.expiresAt)) {
      this.plans.delete(planId);
      throw new Error('Session source lifecycle plan expired; run preflight again.');
    }
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Source lifecycle plan is blocked.');
    const missing = plan.acknowledgements.filter((item) =>
      item.required && !acknowledgements.includes(item.id)
    );
    if (missing.length > 0) throw new Error('Required source lifecycle acknowledgements are missing.');
    if (this.options.catalog.snapshot().revision !== plan.catalogRevision) {
      throw new Error('Cockpit Catalog changed; run source lifecycle preflight again.');
    }
    const device = this.options.getDevice(plan.intent.sessionRef.deviceId);
    if (!device || device.status.state !== 'ready' || !device.workspaceExecute) {
      throw new Error('Session Device is not ready for source lifecycle execution.');
    }
    const currentSnapshot = await device.snapshot();
    const session = [...currentSnapshot.sessions, ...currentSnapshot.archivedSessions].find(
      (candidate) => candidate.id === plan.intent.sessionRef.sessionId
    );
    requireMatchingSession(plan, session);
    const operationId = randomUUID();
    const command = envelope(this.options.cockpitId, plan.devicePlan);
    await this.options.operations.create({ operationId, planId, kind: plan.intent.kind });
    await this.options.operations.update(operationId, {
      state: 'running',
      phase: plan.intent.kind === 'promote-isolated-source' ? 'link-location' : 'cleanup-checkout',
      progress: 20,
      message: plan.intent.kind === 'promote-isolated-source'
        ? 'Linking the promoted ordinary Workspace Location.'
        : 'Running the fresh Device loss scan and cleanup.',
      childCommands: [{ deviceId: command.targetDeviceId, commandId: command.commandId }]
    });
    let phase: 'catalog' | 'device' | 'rebind' = plan.intent.kind === 'promote-isolated-source'
      ? 'catalog'
      : 'device';
    try {
      if (plan.intent.kind === 'promote-isolated-source') {
        if (!plan.preview.workspaceId || !plan.preview.locationId) {
          throw new Error('Promotion plan has no Workspace Location identity.');
        }
        await this.options.catalog.execute({
          expectedRevision: plan.catalogRevision,
          mutations: [{
            type: 'location.link',
            location: {
              id: plan.preview.locationId,
              workspaceId: plan.preview.workspaceId,
              checkout: {
                deviceId: plan.intent.sessionRef.deviceId,
                checkoutId: plan.preview.checkoutId
              },
              state: 'available'
            }
          }]
        });
        phase = 'device';
      }
      await this.options.operations.update(operationId, {
        phase: plan.intent.kind === 'promote-isolated-source' ? 'clear-ownership' : 'remove-worktree',
        progress: 60,
        message: plan.intent.kind === 'promote-isolated-source'
          ? 'Clearing isolated Session ownership on the Device.'
          : 'Removing the eligible isolated Worktree without force.'
      });
      const deviceReceipt = await device.workspaceExecute(command);
      let rebound: Session | null = null;
      if (plan.intent.kind === 'promote-isolated-source') {
        phase = 'rebind';
        if (!device.rebindSessionSource || !plan.preview.locationId) {
          throw new Error('Session Device cannot reclassify the promoted Session Source.');
        }
        await this.options.operations.update(operationId, {
          phase: 'rebind-session',
          progress: 85,
          message: 'Reclassifying the Session Source as an ordinary Workspace Location.'
        });
        rebound = await device.rebindSessionSource({
          sessionId: plan.intent.sessionRef.sessionId,
          expectedVersion: plan.preview.sessionVersion,
          source: {
            kind: 'workspace-location',
            checkoutId: plan.preview.checkoutId,
            locationCorrelation: plan.preview.locationId
          }
        });
      }
      const result: CockpitSessionSourceLifecycleResult = {
        deviceReceipt,
        locationId: plan.preview.locationId,
        session: rebound
      };
      const operation = await this.options.operations.update(operationId, {
        state: 'succeeded',
        phase: 'complete',
        progress: 100,
        message: plan.intent.kind === 'promote-isolated-source'
          ? 'Isolated Session source promoted.'
          : 'Isolated Session source cleaned up.',
        result
      });
      this.plans.delete(planId);
      return operation as CockpitSessionSourceLifecycleOperation;
    } catch (error) {
      await this.options.operations.update(operationId, {
        state: 'needs-attention',
        phase: phase === 'catalog'
          ? 'catalog-link-failed'
          : phase === 'device' ? 'device-command-failed' : 'session-rebind-failed',
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private remember(plan: CockpitSessionSourceLifecyclePlan): void {
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

function validateIntent(intent: CockpitSessionSourceLifecycleIntent): void {
  if (
    !['promote-isolated-source', 'cleanup-isolated-source'].includes(intent?.kind)
    || !isDeviceId(intent?.sessionRef?.deviceId)
    || !isDeviceId(intent?.sessionRef?.sessionId)
  ) throw new Error('Session source lifecycle intent is invalid.');
}

function requireMatchingSession(
  plan: CockpitSessionSourceLifecyclePlan,
  session: Session | undefined
): asserts session is Session {
  if (
    !session
    || (session.version ?? 1) !== plan.preview.sessionVersion
    || session.source?.kind !== 'isolated-worktree'
    || session.source.checkoutId !== plan.preview.checkoutId
  ) throw new Error('Session Source changed after lifecycle preflight.');
}

function envelope(
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
