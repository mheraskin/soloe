import type {
  CockpitDemand,
  CockpitCatalogExportBundle,
  CockpitCatalogImportRequest,
  CockpitCatalogImportResult,
  CockpitDeviceSummary,
  CockpitEvent,
  CockpitPreferencesSnapshot,
  CockpitPreferencesUpdate,
  CockpitRuntimeProjection,
  CockpitSessionProjection,
  CockpitSnapshot,
  CockpitTerminalReplay,
  DeviceReadSnapshot
} from '@shared/types/cockpit.js';
import { sessionRefKey } from '@shared/types/cockpit.js';
import type {
  DeviceEventEnvelope,
  DeviceId,
  TerminalRef
} from '@shared/types/devices.js';
import type { Session, SessionRuntimeState } from '@shared/types/sessions.js';
import type {
  CatalogTransaction,
  CatalogTransactionResult,
  CockpitCatalogSnapshot,
  DeviceWorkspaceSnapshot
} from '@shared/types/workspaces.js';
import type { DeviceWorkspaceIntent, DeviceWorkspacePlan } from '@shared/types/workspaces.js';
import type { DeviceCommandEnvelope, DeviceOperationReceipt } from '@shared/types/commands.js';
import type { CockpitOperation } from '@shared/types/commands.js';
import type {
  CockpitAlignWorkspaceIntent,
  CockpitAlignWorkspaceOperation,
  CockpitAlignWorkspacePlan,
  CockpitPlaceSessionIntent,
  CockpitPlaceSessionOperation,
  CockpitPlaceSessionPlan,
  CockpitSessionSourceLifecycleIntent,
  CockpitSessionSourceLifecycleOperation,
  CockpitSessionSourceLifecyclePlan
} from '@shared/types/workspaces.js';
import { randomUUID } from 'node:crypto';
import type {
  TerminalExitEvent,
  TerminalLocationEvent,
  TerminalInputLease,
  TerminalInputLeaseEvent,
  TerminalOutputEvent,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import type { DevicePort, DevicePortStatus } from './DevicePort.js';
import { ProjectionEngine } from './ProjectionEngine.js';
import { CommandPlanner } from './CommandPlanner.js';
import { AlignmentPlanner } from './AlignmentPlanner.js';
import { PublicationPlanner } from './PublicationPlanner.js';
import { SourceLifecyclePlanner } from './SourceLifecyclePlanner.js';
import type {
  CockpitPublishProjectIntent,
  CockpitPublishProjectOperation,
  CockpitPublishProjectPlan
} from '@shared/types/providers.js';
import type { CockpitOperationStore } from './CockpitOperationStore.js';

const MAX_CONNECTED_DEVICES = 10;

export interface CockpitPublishedEvent {
  event: CockpitEvent;
  audience: ReadonlySet<string> | null;
}

export interface CockpitCoordinatorOptions {
  devices: DevicePort[];
  filterDeviceIds?: DeviceId[];
  defaultPlacementDeviceId?: DeviceId | null;
  preferenceStore?: CockpitPreferencePort;
  catalog?: CockpitCatalogPort;
  operationStore?: CockpitOperationStore;
  now?: () => Date;
}

export interface CockpitPreferencePort {
  get(): CockpitPreferencesSnapshot;
  update(update: CockpitPreferencesUpdate): Promise<CockpitPreferencesSnapshot>;
}

export interface CockpitCatalogPort {
  snapshot(): CockpitCatalogSnapshot;
  execute(transaction: CatalogTransaction): Promise<CatalogTransactionResult>;
  exportBundle?(cockpitId: string, exportEpoch?: string): CockpitCatalogExportBundle;
  importBundle?(request: CockpitCatalogImportRequest): Promise<CockpitCatalogImportResult>;
  onChange(listener: (snapshot: CockpitCatalogSnapshot) => void): () => void;
}

export class CockpitCoordinator {
  private readonly devices = new Map<DeviceId, DevicePort>();
  private readonly deviceSnapshots = new Map<DeviceId, DeviceReadSnapshot>();
  private readonly listeners = new Set<(published: CockpitPublishedEvent) => void>();
  private readonly deviceDetachers = new Map<DeviceId, Array<() => void>>();
  private readonly demandByOwner = new Map<string, CockpitDemand>();
  private readonly refreshes = new Map<DeviceId, Promise<void>>();
  private readonly now: () => Date;
  private readonly preferenceStore: CockpitPreferencePort | null;
  private readonly cockpitId: string;
  private readonly catalog: CockpitCatalogPort | null;
  private readonly projection = new ProjectionEngine();
  private readonly commandPlanner: CommandPlanner | null;
  private readonly alignmentPlanner: AlignmentPlanner | null;
  private readonly publicationPlanner: PublicationPlanner | null;
  private readonly sourceLifecyclePlanner: SourceLifecyclePlanner | null;
  private readonly operationStore: CockpitOperationStore | null;
  private detachCatalog: (() => void) | null = null;
  private filterDeviceIds: DeviceId[];
  private defaultPlacementDeviceId: DeviceId | null;
  private revision = 0;
  private started = false;
  private disposed = false;

  constructor(options: CockpitCoordinatorOptions) {
    if (options.devices.length > MAX_CONNECTED_DEVICES) {
      throw new Error(`Cockpit supports at most ${MAX_CONNECTED_DEVICES} enabled Devices.`);
    }
    for (const device of options.devices) {
      if (this.devices.has(device.deviceId)) {
        throw new Error(`Duplicate Device client: ${device.deviceId}`);
      }
      this.devices.set(device.deviceId, device);
    }
    this.preferenceStore = options.preferenceStore ?? null;
    this.cockpitId = this.preferenceStore?.get().cockpitId ?? randomUUID();
    this.catalog = options.catalog ?? null;
    this.operationStore = options.operationStore ?? null;
    this.commandPlanner = this.catalog && options.operationStore
      ? new CommandPlanner({
          cockpitId: this.cockpitId,
          catalog: this.catalog,
          operations: options.operationStore,
          getDevice: (deviceId) => this.devices.get(deviceId) ?? null,
          now: options.now
        })
      : null;
    this.alignmentPlanner = this.catalog && options.operationStore
      ? new AlignmentPlanner({
          cockpitId: this.cockpitId,
          catalog: this.catalog,
          operations: options.operationStore,
          getDevice: (deviceId) => this.devices.get(deviceId) ?? null,
          now: options.now
        })
      : null;
    this.publicationPlanner = this.catalog && options.operationStore
      ? new PublicationPlanner({
          cockpitId: this.cockpitId,
          catalog: this.catalog,
          operations: options.operationStore,
          getDevice: (deviceId) => this.devices.get(deviceId) ?? null,
          now: options.now
        })
      : null;
    this.sourceLifecyclePlanner = this.catalog && options.operationStore
      ? new SourceLifecyclePlanner({
          cockpitId: this.cockpitId,
          catalog: this.catalog,
          operations: options.operationStore,
          getDevice: (deviceId) => this.devices.get(deviceId) ?? null,
          now: options.now
        })
      : null;
    this.detachCatalog = this.catalog?.onChange(() => {
      if (this.disposed) return;
      this.changed();
      if (this.started) this.publish({ type: 'snapshot', snapshot: this.snapshot() });
    }) ?? null;
    const preferences = this.preferenceStore?.get();
    this.filterDeviceIds = uniqueKnownDevices(
      options.filterDeviceIds ?? preferences?.filterDeviceIds ?? [],
      this.devices
    );
    const preferredDefault = options.defaultPlacementDeviceId
      ?? preferences?.defaultPlacementDeviceId
      ?? null;
    this.defaultPlacementDeviceId = preferredDefault
      && this.devices.has(preferredDefault)
      ? preferredDefault
      : this.devices.keys().next().value ?? null;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.assertActive();
    if (this.started) return;
    this.started = true;
    for (const device of this.devices.values()) {
      this.attachDevice(device);
      void this.refreshDevice(device).catch(() => undefined);
    }
  }

  async reconcileDevices(nextDevices: DevicePort[]): Promise<CockpitSnapshot> {
    this.assertActive();
    if (nextDevices.length > MAX_CONNECTED_DEVICES) {
      throw new Error(`Cockpit supports at most ${MAX_CONNECTED_DEVICES} enabled Devices.`);
    }
    const next = new Map<DeviceId, DevicePort>();
    for (const device of nextDevices) {
      if (next.has(device.deviceId)) throw new Error(`Duplicate Device client: ${device.deviceId}`);
      next.set(device.deviceId, device);
    }

    for (const [deviceId, current] of [...this.devices]) {
      const replacement = next.get(deviceId);
      if (replacement === current) continue;
      this.detachDevice(deviceId);
      this.devices.delete(deviceId);
      this.deviceSnapshots.delete(deviceId);
      await current.dispose();
    }
    const additions: DevicePort[] = [];
    for (const [deviceId, device] of next) {
      if (this.devices.has(deviceId)) continue;
      this.devices.set(deviceId, device);
      additions.push(device);
      if (this.started) this.attachDevice(device);
    }

    const nextFilter = uniqueKnownDevices(this.filterDeviceIds, this.devices);
    const nextDefault = this.defaultPlacementDeviceId
      && this.devices.has(this.defaultPlacementDeviceId)
      ? this.defaultPlacementDeviceId
      : this.devices.keys().next().value ?? null;
    if (
      nextFilter.length !== this.filterDeviceIds.length
      || nextDefault !== this.defaultPlacementDeviceId
    ) {
      await this.preferenceStore?.update({
        filterDeviceIds: nextFilter,
        defaultPlacementDeviceId: nextDefault
      });
      this.filterDeviceIds = nextFilter;
      this.defaultPlacementDeviceId = nextDefault;
    }
    await this.reconcileDemand();
    if (this.started) {
      await Promise.allSettled(additions.map((device) => this.refreshDevice(device)));
    }
    this.changed();
    const snapshot = this.snapshot();
    this.publish({ type: 'snapshot', snapshot });
    return snapshot;
  }

  async refreshAll(): Promise<CockpitSnapshot> {
    this.assertActive();
    this.start();
    await Promise.allSettled([...this.devices.values()].map((device) =>
      this.refreshDevice(device)
    ));
    return this.snapshot();
  }

  snapshot(): CockpitSnapshot {
    this.assertActive();
    if (!this.started) this.start();
    const deviceSummaries = [...this.devices.values()]
      .map((device) => deviceSummary(device.status))
      .sort((left, right) => left.name.localeCompare(right.name));
    const sessions: CockpitSessionProjection[] = [];
    const archivedSessions: CockpitSessionProjection[] = [];
    for (const device of this.devices.values()) {
      const snapshot = this.deviceSnapshots.get(device.deviceId);
      if (!snapshot) continue;
      sessions.push(...projectSessions(device.deviceId, snapshot.descriptor.name, snapshot));
      archivedSessions.push(...projectArchivedSessions(
        device.deviceId,
        snapshot.descriptor.name,
        snapshot
      ));
    }
    const catalog = this.catalog?.snapshot() ?? null;
    const deviceWorkspaces = new Map<DeviceId, DeviceWorkspaceSnapshot>();
    for (const [deviceId, snapshot] of this.deviceSnapshots) {
      if (snapshot.workspace) deviceWorkspaces.set(deviceId, structuredClone(snapshot.workspace));
    }
    const navigation = catalog
      ? this.projection.project({
          catalog,
          devices: deviceSummaries,
          sessions,
          deviceWorkspaces
        })
      : null;
    return {
      cockpitId: this.cockpitId,
      revision: this.revision,
      capturedAt: this.now().toISOString(),
      devices: deviceSummaries,
      sessions,
      archivedSessions,
      catalog,
      navigation,
      filterDeviceIds: [...this.filterDeviceIds],
      defaultPlacementDeviceId: this.defaultPlacementDeviceId,
      recoverableOperations: this.operationStore?.listRecoverable() ?? []
    };
  }

  async transactCatalog(transaction: CatalogTransaction): Promise<CockpitSnapshot> {
    this.assertActive();
    if (!this.catalog) throw new Error('Cockpit Catalog is unavailable.');
    await this.catalog.execute(structuredClone(transaction));
    return this.snapshot();
  }

  exportCatalog(exportEpoch?: string): CockpitCatalogExportBundle {
    this.assertActive();
    if (!this.catalog?.exportBundle) throw new Error('Cockpit Catalog export is unavailable.');
    return this.catalog.exportBundle(this.cockpitId, exportEpoch);
  }

  async importCatalog(request: CockpitCatalogImportRequest): Promise<CockpitCatalogImportResult> {
    this.assertActive();
    if (!this.catalog?.importBundle) throw new Error('Cockpit Catalog import is unavailable.');
    const result = await this.catalog.importBundle(structuredClone(request));
    this.changed();
    this.publish({ type: 'snapshot', snapshot: this.snapshot() });
    return result;
  }

  async setDemand(ownerId: string, demand: CockpitDemand): Promise<void> {
    this.assertActive();
    const owner = requiredOwnerId(ownerId);
    this.demandByOwner.set(owner, normalizeDemand(demand, this.devices));
    await this.reconcileDemand();
  }

  async releaseDemand(ownerId: string): Promise<void> {
    if (this.disposed) return;
    this.demandByOwner.delete(ownerId);
    await this.reconcileDemand();
  }

  async setFilter(deviceIds: DeviceId[]): Promise<CockpitSnapshot> {
    this.assertActive();
    const filterDeviceIds = uniqueKnownDevices(deviceIds, this.devices);
    await this.preferenceStore?.update({ filterDeviceIds });
    this.filterDeviceIds = filterDeviceIds;
    this.changed();
    const snapshot = this.snapshot();
    this.publish({ type: 'snapshot', snapshot });
    return snapshot;
  }

  async setDefaultPlacement(deviceId: DeviceId): Promise<CockpitSnapshot> {
    this.assertActive();
    this.requireDevice(deviceId);
    await this.preferenceStore?.update({ defaultPlacementDeviceId: deviceId });
    this.defaultPlacementDeviceId = deviceId;
    this.changed();
    const snapshot = this.snapshot();
    this.publish({ type: 'snapshot', snapshot });
    return snapshot;
  }

  async terminalInput(terminalRef: TerminalRef, data: string): Promise<void> {
    const device = this.requireDevice(terminalRef.deviceId);
    await device.terminalInput(terminalRef.terminalId, data);
  }

  async takeTerminalInputControl(terminalRef: TerminalRef): Promise<TerminalInputLease> {
    const device = this.requireDevice(terminalRef.deviceId);
    if (!device.terminalAcquireInputLease) {
      throw new Error(`Device ${terminalRef.deviceId} does not support terminal input leases.`);
    }
    return device.terminalAcquireInputLease(terminalRef.terminalId, true);
  }

  async terminalResize(terminalRef: TerminalRef, cols: number, rows: number): Promise<void> {
    const device = this.requireDevice(terminalRef.deviceId);
    await device.terminalResize(terminalRef.terminalId, cols, rows);
  }

  async terminalReplay(terminalRef: TerminalRef, afterSeq = 0): Promise<CockpitTerminalReplay> {
    const device = this.requireDevice(terminalRef.deviceId);
    return device.terminalReplay(terminalRef.terminalId, afterSeq);
  }

  async terminalStop(terminalRef: TerminalRef): Promise<void> {
    const device = this.requireDevice(terminalRef.deviceId);
    await device.terminalStop(terminalRef.terminalId);
  }

  async workspacePlan(
    deviceId: DeviceId,
    intent: DeviceWorkspaceIntent
  ): Promise<DeviceWorkspacePlan> {
    const device = this.requireDevice(deviceId);
    if (!device.workspacePlan) throw new Error(`Device ${deviceId} does not support Workspace placement.`);
    return device.workspacePlan(structuredClone(intent));
  }

  async workspaceExecute(
    command: DeviceCommandEnvelope<DeviceWorkspaceIntent>
  ): Promise<DeviceOperationReceipt> {
    const device = this.requireDevice(command.targetDeviceId);
    if (!device.workspaceExecute) {
      throw new Error(`Device ${command.targetDeviceId} does not support Workspace placement.`);
    }
    const receipt = await device.workspaceExecute(structuredClone(command));
    await this.refreshDevice(device);
    return receipt;
  }

  async workspaceGetCommand(
    deviceId: DeviceId,
    cockpitId: string,
    commandId: string
  ): Promise<DeviceOperationReceipt | null> {
    const device = this.requireDevice(deviceId);
    if (!device.workspaceGetCommand) {
      throw new Error(`Device ${deviceId} does not support operation receipts.`);
    }
    return device.workspaceGetCommand(cockpitId, commandId);
  }

  async planSessionPlacement(
    intent: CockpitPlaceSessionIntent
  ): Promise<CockpitPlaceSessionPlan> {
    if (!this.commandPlanner) throw new Error('Session placement is unavailable.');
    return this.commandPlanner.planPlacement(structuredClone(intent));
  }

  async executeSessionPlacement(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitPlaceSessionOperation> {
    if (!this.commandPlanner) throw new Error('Session placement is unavailable.');
    const operation = await this.commandPlanner.executePlacement(planId, [...acknowledgements]);
    await this.refreshDevice(this.requireDevice(operation.result!.sessionRef.deviceId));
    this.changed();
    this.publish({ type: 'snapshot', snapshot: this.snapshot() });
    return operation;
  }

  planWorkspaceAlignment(
    intent: CockpitAlignWorkspaceIntent
  ): Promise<CockpitAlignWorkspacePlan> {
    if (!this.alignmentPlanner) throw new Error('Workspace alignment is unavailable.');
    return this.alignmentPlanner.plan(structuredClone(intent));
  }

  async executeWorkspaceAlignment(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitAlignWorkspaceOperation> {
    if (!this.alignmentPlanner) throw new Error('Workspace alignment is unavailable.');
    const operation = await this.alignmentPlanner.execute(planId, [...acknowledgements]);
    await Promise.all([
      this.refreshDevice(this.requireDevice(operation.result!.sourceReceipt.targetDeviceId)),
      this.refreshDevice(this.requireDevice(operation.result!.targetReceipt.targetDeviceId))
    ]);
    this.changed();
    this.publish({ type: 'snapshot', snapshot: this.snapshot() });
    return operation;
  }

  planProjectPublication(
    intent: CockpitPublishProjectIntent
  ): Promise<CockpitPublishProjectPlan> {
    if (!this.publicationPlanner) throw new Error('Project publication is unavailable.');
    return this.publicationPlanner.plan(structuredClone(intent));
  }

  async executeProjectPublication(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitPublishProjectOperation> {
    if (!this.publicationPlanner) throw new Error('Project publication is unavailable.');
    const operation = await this.publicationPlanner.execute(planId, [...acknowledgements]);
    await this.refreshDevice(this.requireDevice(operation.result!.providerReceipt.targetDeviceId));
    this.changed();
    this.publish({ type: 'snapshot', snapshot: this.snapshot() });
    return operation;
  }

  planSessionSourceLifecycle(
    intent: CockpitSessionSourceLifecycleIntent
  ): Promise<CockpitSessionSourceLifecyclePlan> {
    if (!this.sourceLifecyclePlanner) throw new Error('Session source lifecycle is unavailable.');
    return this.sourceLifecyclePlanner.plan(structuredClone(intent));
  }

  async executeSessionSourceLifecycle(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitSessionSourceLifecycleOperation> {
    if (!this.sourceLifecyclePlanner) throw new Error('Session source lifecycle is unavailable.');
    const operation = await this.sourceLifecyclePlanner.execute(planId, [...acknowledgements]);
    await this.refreshDevice(this.requireDevice(operation.result!.deviceReceipt.targetDeviceId));
    this.changed();
    this.publish({ type: 'snapshot', snapshot: this.snapshot() });
    return operation;
  }

  getCockpitOperation(operationId: string): CockpitOperation | null {
    if (!this.operationStore) throw new Error('Cockpit operations are unavailable.');
    return this.operationStore.get(operationId);
  }

  listRecoverableOperations(): CockpitOperation[] {
    if (!this.operationStore) return [];
    return this.operationStore.listRecoverable();
  }

  onEvent(listener: (published: CockpitPublishedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.detachCatalog?.();
    this.detachCatalog = null;
    for (const deviceId of [...this.deviceDetachers.keys()]) this.detachDevice(deviceId);
    await Promise.allSettled([...this.devices.values()].map((device) => device.dispose()));
    this.devices.clear();
    this.deviceSnapshots.clear();
    this.demandByOwner.clear();
    this.listeners.clear();
  }

  private async refreshDevice(device: DevicePort): Promise<void> {
    const existing = this.refreshes.get(device.deviceId);
    if (existing) return existing;
    const refresh = this.refreshDeviceNow(device).finally(() => {
      if (this.refreshes.get(device.deviceId) === refresh) {
        this.refreshes.delete(device.deviceId);
      }
    });
    this.refreshes.set(device.deviceId, refresh);
    return refresh;
  }

  private async refreshDeviceNow(device: DevicePort): Promise<void> {
    try {
      const status = await device.connect();
      if (status.state !== 'ready') return;
      const snapshot = await device.snapshot();
      if (this.devices.get(device.deviceId) !== device) return;
      if (snapshot.descriptor.deviceId !== device.deviceId) {
        throw new Error('Device snapshot identity differs from its connection identity.');
      }
      this.deviceSnapshots.set(device.deviceId, structuredClone(snapshot));
      this.changed();
      this.publish({ type: 'snapshot', snapshot: this.snapshot() });
    } catch {
      this.changed();
      this.publish({ type: 'device', device: deviceSummary(device.status) });
    }
  }

  private receiveDeviceStatus(status: DevicePortStatus): void {
    if (this.disposed || !this.devices.has(status.deviceId)) return;
    this.changed();
    this.publish({ type: 'device', device: deviceSummary(status) });
  }

  private attachDevice(device: DevicePort): void {
    if (this.deviceDetachers.has(device.deviceId)) return;
    this.deviceDetachers.set(device.deviceId, [
      device.onEvent((event) => this.receiveDeviceEvent(device, event)),
      device.onStatus((status) => this.receiveDeviceStatus(status))
    ]);
  }

  private detachDevice(deviceId: DeviceId): void {
    const detachers = this.deviceDetachers.get(deviceId) ?? [];
    this.deviceDetachers.delete(deviceId);
    for (const detach of detachers) detach();
  }

  private receiveDeviceEvent(device: DevicePort, envelope: DeviceEventEnvelope): void {
    if (this.disposed || envelope.deviceId !== device.deviceId) return;
    if (envelope.event === 'transport.repair') {
      this.publish({
        type: 'repair',
        deviceId: device.deviceId,
        reason: repairReason(envelope.payload)
      });
      void this.refreshDevice(device).catch(() => undefined);
      return;
    }
    const snapshot = this.deviceSnapshots.get(device.deviceId);
    if (envelope.event === 'sessions.change') {
      const session = parseSessionPayload(envelope.payload);
      if (!session || !snapshot) return;
      upsertSession(snapshot, session);
      this.changed();
      this.publish({
        type: 'session.changed',
        session: projectSession(device.deviceId, snapshot.descriptor.name, snapshot, session)
      });
      return;
    }
    if (envelope.event === 'sessions.delete') {
      const sessionId = typeof envelope.payload === 'string' ? envelope.payload : null;
      if (!sessionId || !snapshot) return;
      snapshot.sessions = snapshot.sessions.filter((session) => session.id !== sessionId);
      snapshot.archivedSessions = snapshot.archivedSessions.filter(
        (session) => session.id !== sessionId
      );
      snapshot.runtimes = snapshot.runtimes.filter((runtime) => runtime.sessionId !== sessionId);
      this.changed();
      this.publish({
        type: 'session.deleted',
        ref: { deviceId: device.deviceId, sessionId }
      });
      return;
    }
    if (envelope.event === 'output') {
      const event = parseTerminalOutput(envelope.payload);
      if (!event) return;
      const terminalRef = { deviceId: device.deviceId, terminalId: event.terminalId };
      this.publish({
        type: 'terminal.output',
        terminalRef,
        sessionRef: { deviceId: device.deviceId, sessionId: event.sessionId },
        event
      }, this.demandAudience(terminalRef));
      return;
    }
    if (envelope.event === 'exit') {
      const event = parseTerminalExit(envelope.payload);
      if (!event) return;
      this.applyRuntimeExit(device.deviceId, event);
      this.publish({
        type: 'terminal.exit',
        terminalRef: { deviceId: device.deviceId, terminalId: event.terminalId },
        sessionRef: { deviceId: device.deviceId, sessionId: event.sessionId },
        event
      });
      return;
    }
    if (envelope.event === 'status') {
      const event = parseTerminalStatus(envelope.payload);
      if (!event) return;
      this.applyRuntimeStatus(device.deviceId, event);
      this.publish({
        type: 'terminal.status',
        terminalRef: event.terminalId
          ? { deviceId: device.deviceId, terminalId: event.terminalId }
          : null,
        sessionRef: { deviceId: device.deviceId, sessionId: event.sessionId },
        event
      });
      return;
    }
    if (envelope.event === 'location') {
      const event = parseTerminalLocation(envelope.payload);
      if (!event) return;
      this.applyRuntimeLocation(device.deviceId, event);
      this.publish({
        type: 'terminal.location',
        terminalRef: { deviceId: device.deviceId, terminalId: event.terminalId },
        sessionRef: { deviceId: device.deviceId, sessionId: event.sessionId },
        event
      });
      return;
    }
    if (envelope.event === 'inputLease') {
      const event = parseTerminalInputLease(envelope.payload);
      if (!event) return;
      this.publish({
        type: 'terminal.input-lease',
        terminalRef: { deviceId: device.deviceId, terminalId: event.terminalId },
        event
      });
    }
  }

  private applyRuntimeExit(deviceId: DeviceId, event: TerminalExitEvent): void {
    const snapshot = this.deviceSnapshots.get(deviceId);
    if (!snapshot) return;
    const existing = snapshot.runtimes.find((runtime) => runtime.sessionId === event.sessionId);
    const next: SessionRuntimeState = {
      ...(existing ?? { sessionId: event.sessionId }),
      sessionId: event.sessionId,
      terminalId: event.terminalId,
      status: 'exited',
      exitCode: event.exitCode,
      signal: event.signal,
      exitedAt: this.now().toISOString()
    };
    upsertRuntime(snapshot, next);
    this.changed();
  }

  private applyRuntimeStatus(deviceId: DeviceId, event: TerminalStatusEvent): void {
    const snapshot = this.deviceSnapshots.get(deviceId);
    if (!snapshot) return;
    const existing = snapshot.runtimes.find((runtime) => runtime.sessionId === event.sessionId);
    const next: SessionRuntimeState = {
      ...(existing ?? { sessionId: event.sessionId }),
      sessionId: event.sessionId,
      terminalId: event.terminalId,
      status: event.status,
      ...(event.message ? { error: event.message } : {})
    };
    upsertRuntime(snapshot, next);
    this.changed();
  }

  private applyRuntimeLocation(deviceId: DeviceId, event: TerminalLocationEvent): void {
    const snapshot = this.deviceSnapshots.get(deviceId);
    if (!snapshot) return;
    const runtime = snapshot.runtimes.find((item) => item.sessionId === event.sessionId);
    if (!runtime) return;
    runtime.cwd = event.cwd;
    this.changed();
  }

  private demandAudience(ref: TerminalRef): ReadonlySet<string> {
    const audience = new Set<string>();
    for (const [owner, demand] of this.demandByOwner) {
      if (demand.terminalOutput.some((candidate) => sameTerminalRef(candidate, ref))) {
        audience.add(owner);
      }
    }
    return audience;
  }

  private async reconcileDemand(): Promise<void> {
    const byDevice = new Map<DeviceId, Set<string>>();
    for (const demand of this.demandByOwner.values()) {
      for (const ref of demand.terminalOutput) {
        const current = byDevice.get(ref.deviceId) ?? new Set<string>();
        current.add(ref.terminalId);
        byDevice.set(ref.deviceId, current);
      }
    }
    await Promise.all([...this.devices.values()].map((device) =>
      device.setTerminalOutputDemand(byDevice.get(device.deviceId) ?? new Set())
    ));
  }

  private requireDevice(deviceId: DeviceId): DevicePort {
    this.assertActive();
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Unknown or disabled Device: ${deviceId}`);
    if (device.status.state !== 'ready') {
      throw new Error(`Device ${device.status.descriptor?.name ?? deviceId} is not ready.`);
    }
    return device;
  }

  private changed(): void {
    this.revision += 1;
  }

  private publish(event: CockpitEvent, audience: ReadonlySet<string> | null = null): void {
    const published = { event, audience };
    for (const listener of this.listeners) {
      try {
        listener(published);
      } catch {
        // A renderer listener must not own cockpit lifecycle.
      }
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Cockpit coordinator is disposed.');
  }
}

function projectSessions(
  deviceId: DeviceId,
  deviceName: string,
  snapshot: DeviceReadSnapshot
): CockpitSessionProjection[] {
  return snapshot.sessions.map((session) =>
    projectSession(deviceId, deviceName, snapshot, session)
  );
}

function projectArchivedSessions(
  deviceId: DeviceId,
  deviceName: string,
  snapshot: DeviceReadSnapshot
): CockpitSessionProjection[] {
  return snapshot.archivedSessions.map((session) =>
    projectSession(deviceId, deviceName, snapshot, session)
  );
}

function projectSession(
  deviceId: DeviceId,
  deviceName: string,
  snapshot: DeviceReadSnapshot,
  session: Session
): CockpitSessionProjection {
  const ref = { deviceId, sessionId: session.id };
  const runtime = snapshot.runtimes.find((candidate) => candidate.sessionId === session.id);
  return {
    ref,
    key: sessionRefKey(ref),
    deviceName,
    session: structuredClone(session),
    runtime: runtime ? projectRuntime(deviceId, runtime) : null
  };
}

function projectRuntime(deviceId: DeviceId, state: SessionRuntimeState): CockpitRuntimeProjection {
  return {
    sessionRef: { deviceId, sessionId: state.sessionId },
    terminalRef: state.terminalId ? { deviceId, terminalId: state.terminalId } : null,
    state: structuredClone(state)
  };
}

function deviceSummary(status: DevicePortStatus): CockpitDeviceSummary {
  const descriptor = status.descriptor;
  const state: CockpitDeviceSummary['state'] = status.state === 'ready'
    ? 'ready'
    : status.state === 'connecting' || status.state === 'idle'
      ? 'connecting'
      : status.state === 'incompatible'
        ? 'incompatible'
        : 'offline';
  return {
    deviceId: status.deviceId,
    name: descriptor?.name ?? `Device ${status.deviceId.slice(0, 8)}`,
    state,
    ...(descriptor?.platform ? { platform: descriptor.platform } : {}),
    ...(descriptor ? { capabilityRevision: descriptor.capabilities.revision } : {}),
    ...(descriptor ? { capabilities: [...descriptor.capabilities.features] } : {}),
    ...(status.error ? { error: status.error } : {})
  };
}

function normalizeDemand(
  demand: CockpitDemand,
  devices: ReadonlyMap<DeviceId, DevicePort>
): CockpitDemand {
  if (!demand || !Array.isArray(demand.terminalOutput)) {
    throw new Error('Cockpit demand is invalid.');
  }
  const unique = new Map<string, TerminalRef>();
  for (const ref of demand.terminalOutput) {
    if (!ref || !devices.has(ref.deviceId) || typeof ref.terminalId !== 'string' || !ref.terminalId.trim()) {
      throw new Error('Cockpit terminal demand targets an unknown Device or Terminal.');
    }
    unique.set(`${ref.deviceId}\u0000${ref.terminalId}`, {
      deviceId: ref.deviceId,
      terminalId: ref.terminalId
    });
  }
  return { terminalOutput: [...unique.values()] };
}

function uniqueKnownDevices(
  deviceIds: DeviceId[],
  devices: ReadonlyMap<DeviceId, DevicePort>
): DeviceId[] {
  return [...new Set(deviceIds)].filter((deviceId) => devices.has(deviceId));
}

function requiredOwnerId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new Error('Cockpit owner ID is invalid.');
  return value;
}

function sameTerminalRef(left: TerminalRef, right: TerminalRef): boolean {
  return left.deviceId === right.deviceId && left.terminalId === right.terminalId;
}

function upsertSession(snapshot: DeviceReadSnapshot, session: Session): void {
  snapshot.sessions = snapshot.sessions.filter((candidate) => candidate.id !== session.id);
  snapshot.archivedSessions = snapshot.archivedSessions.filter(
    (candidate) => candidate.id !== session.id
  );
  if (session.archivedAt) snapshot.archivedSessions.push(structuredClone(session));
  else snapshot.sessions.push(structuredClone(session));
}

function upsertRuntime(snapshot: DeviceReadSnapshot, runtime: SessionRuntimeState): void {
  snapshot.runtimes = snapshot.runtimes.filter(
    (candidate) => candidate.sessionId !== runtime.sessionId
  );
  snapshot.runtimes.push(runtime);
}

function parseSessionPayload(value: unknown): Session | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['name'] !== 'string') {
    return null;
  }
  return structuredClone(value) as unknown as Session;
}

function parseTerminalOutput(value: unknown): TerminalOutputEvent | null {
  if (!isTerminalEventBase(value) || typeof value['data'] !== 'string' || !positiveSequence(value['seq'])) {
    return null;
  }
  return value as unknown as TerminalOutputEvent;
}

function parseTerminalExit(value: unknown): TerminalExitEvent | null {
  if (!isTerminalEventBase(value)) return null;
  const exitCode = value['exitCode'];
  const signal = value['signal'];
  if ((exitCode !== null && !Number.isInteger(exitCode)) || (signal !== null && !Number.isInteger(signal))) {
    return null;
  }
  return value as unknown as TerminalExitEvent;
}

function parseTerminalStatus(value: unknown): TerminalStatusEvent | null {
  if (!isRecord(value) || typeof value['sessionId'] !== 'string') return null;
  if (value['terminalId'] !== null && typeof value['terminalId'] !== 'string') return null;
  if (!['stopped', 'starting', 'running', 'exited', 'error'].includes(String(value['status']))) {
    return null;
  }
  return value as unknown as TerminalStatusEvent;
}

function parseTerminalLocation(value: unknown): TerminalLocationEvent | null {
  return isTerminalEventBase(value) && typeof value['cwd'] === 'string'
    ? value as unknown as TerminalLocationEvent
    : null;
}

function parseTerminalInputLease(value: unknown): TerminalInputLeaseEvent | null {
  if (!isRecord(value)) return null;
  if (
    !['acquired', 'renewed', 'released', 'expired', 'taken-over'].includes(
      String(value['type'])
    )
    || typeof value['terminalId'] !== 'string'
    || !value['terminalId']
    || typeof value['observedAt'] !== 'string'
    || !Number.isFinite(Date.parse(value['observedAt']))
  ) return null;
  const lease = value['lease'];
  if (lease !== null && !isTerminalInputLease(lease)) return null;
  if (value['previousOwnerId'] !== undefined && typeof value['previousOwnerId'] !== 'string') {
    return null;
  }
  return structuredClone(value) as unknown as TerminalInputLeaseEvent;
}

function isTerminalInputLease(value: unknown): value is TerminalInputLease {
  return isRecord(value)
    && typeof value['terminalId'] === 'string'
    && Boolean(value['terminalId'])
    && typeof value['leaseId'] === 'string'
    && Boolean(value['leaseId'])
    && typeof value['ownerId'] === 'string'
    && Boolean(value['ownerId'])
    && typeof value['acquiredAt'] === 'string'
    && Number.isFinite(Date.parse(value['acquiredAt']))
    && typeof value['expiresAt'] === 'string'
    && Number.isFinite(Date.parse(value['expiresAt']));
}

function isTerminalEventBase(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value['terminalId'] === 'string'
    && Boolean(value['terminalId'])
    && typeof value['sessionId'] === 'string'
    && Boolean(value['sessionId']);
}

function positiveSequence(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function repairReason(payload: unknown): string {
  return isRecord(payload) && typeof payload['reason'] === 'string'
    ? payload['reason']
    : 'transport repair required';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
