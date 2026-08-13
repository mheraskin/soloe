import type {
  CockpitDeviceSummary,
  CockpitCatalogExportBundle,
  CockpitCatalogImportResult,
  CockpitEvent,
  CockpitSessionProjection,
  CockpitSnapshot,
  CockpitTerminalReplay
} from '@shared/types/cockpit.js';
import { terminalRefKey } from '@shared/types/cockpit.js';
import type { DeviceId, TerminalRef } from '@shared/types/devices.js';
import type { SessionRuntimeState } from '@shared/types/sessions.js';
import type { TerminalInputLeaseEvent, TerminalOutputEvent } from '@shared/types/terminal.js';
import type {
  CatalogTransaction,
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
import type { CockpitOperation } from '@shared/types/commands.js';
import { ipc } from '../lib/ipc';
import { migrateCockpitPresentationState } from '../lib/cockpit-presentation-migration.js';
import type {
  CockpitPublishProjectIntent,
  CockpitPublishProjectOperation,
  CockpitPublishProjectPlan
} from '@shared/types/providers.js';

const EMPTY_SNAPSHOT: CockpitSnapshot = {
  cockpitId: '11111111-1111-4111-8111-111111111111',
  revision: 0,
  capturedAt: new Date(0).toISOString(),
  devices: [],
  sessions: [],
  archivedSessions: [],
  catalog: null,
  navigation: null,
  filterDeviceIds: [],
  defaultPlacementDeviceId: null,
  recoverableOperations: []
};

export class CockpitStore {
  readonly supported = ipc.cockpit.supported;
  snapshot = $state<CockpitSnapshot>(structuredClone(EMPTY_SNAPSHOT));
  loaded = $state(false);
  refreshing = $state(false);
  selectedSessionKey = $state<string | null>(null);
  inputLeaseEvents = $state<Record<string, TerminalInputLeaseEvent>>({});
  private detachEvent: (() => void) | null = null;
  private loadRequest: Promise<void> | null = null;
  private readonly terminalOutputListeners = new Map<
    string,
    { ref: TerminalRef; listeners: Set<(event: TerminalOutputEvent) => void> }
  >();
  private demandSync: Promise<void> = Promise.resolve();

  get visibleSessions(): CockpitSessionProjection[] {
    const filters = new Set(this.snapshot.filterDeviceIds);
    return filters.size === 0
      ? this.snapshot.sessions
      : this.snapshot.sessions.filter((session) => filters.has(session.ref.deviceId));
  }

  get selectedProjection(): CockpitSessionProjection | null {
    if (!this.selectedSessionKey) return null;
    return this.snapshot.sessions.find((session) => session.key === this.selectedSessionKey) ?? null;
  }

  selectSession(key: string): void {
    const session = this.snapshot.sessions.find((candidate) => candidate.key === key);
    if (!session) return;
    const owner = this.device(session.ref.deviceId);
    if (!owner || owner.state !== 'ready') return;
    this.selectedSessionKey = key;
  }

  clearSelectedSession(): void {
    this.selectedSessionKey = null;
  }

  device(deviceId: DeviceId): CockpitDeviceSummary | null {
    return this.snapshot.devices.find((device) => device.deviceId === deviceId) ?? null;
  }

  load(): Promise<void> {
    if (!this.supported) {
      this.loaded = true;
      return Promise.resolve();
    }
    if (this.loadRequest) return this.loadRequest;
    this.loadRequest = ipc.cockpit.snapshot()
      .then((snapshot) => {
        this.snapshot = snapshot;
        const migrations = snapshot.catalog?.migrations ?? [];
        const projectMap = Object.assign({}, ...migrations.map((migration) => migration.projectMap));
        const workspaceMap = Object.assign({}, ...migrations.map((migration) => migration.workspaceMap));
        if (typeof localStorage !== 'undefined') {
          migrateCockpitPresentationState(localStorage, {
            catalogRevision: snapshot.catalog?.revision ?? 0,
            deviceIds: snapshot.devices.map((device) => device.deviceId),
            projectMap,
            workspaceMap
          });
        }
        this.loaded = true;
        this.attach();
        void this.refresh().catch(() => undefined);
      })
      .finally(() => {
        this.loadRequest = null;
      });
    return this.loadRequest;
  }

  async refresh(): Promise<void> {
    if (!this.supported || this.refreshing) return;
    this.refreshing = true;
    try {
      this.snapshot = await ipc.cockpit.refresh();
      this.clearUnavailableSelection();
    } finally {
      this.refreshing = false;
    }
  }

  async setFilter(deviceIds: DeviceId[]): Promise<void> {
    if (!this.supported) return;
    this.snapshot = await ipc.cockpit.setFilter([...deviceIds]);
  }

  async setDefaultPlacement(deviceId: DeviceId): Promise<void> {
    if (!this.supported) return;
    this.snapshot = await ipc.cockpit.setDefaultPlacement(deviceId);
  }

  async transactCatalog(transaction: CatalogTransaction): Promise<void> {
    if (!this.supported) throw new Error('Cockpit Catalog is unavailable.');
    this.snapshot = await ipc.cockpit.transactCatalog(structuredClone(transaction));
  }

  async exportCatalog(): Promise<CockpitCatalogExportBundle> {
    if (!this.supported) throw new Error('Cockpit Catalog export is unavailable.');
    return ipc.cockpit.exportCatalog();
  }

  async downloadCatalogExport(): Promise<void> {
    const bundle = await this.exportCatalog();
    const stamp = bundle.manifest.exportedAt.replace(/[:.]/gu, '-');
    await ipc.system.saveText({
      defaultPath: `soloe-cockpit-catalog-${stamp}.json`,
      content: `${JSON.stringify(bundle, null, 2)}\n`
    });
  }

  async importCatalog(bundle: CockpitCatalogExportBundle): Promise<CockpitCatalogImportResult> {
    if (!this.supported || !this.snapshot.catalog) {
      throw new Error('Cockpit Catalog import is unavailable.');
    }
    const result = await ipc.cockpit.importCatalog({
      bundle: structuredClone(bundle),
      expectedRevision: this.snapshot.catalog.revision,
      replace: true
    });
    await this.refresh();
    return result;
  }

  async refreshRecoverableOperations(): Promise<CockpitOperation[]> {
    if (!this.supported) return [];
    const recoverableOperations = await ipc.cockpit.operationListRecoverable();
    this.snapshot = { ...this.snapshot, recoverableOperations };
    return recoverableOperations;
  }

  redactedOperationReport(operation: CockpitOperation): string {
    return JSON.stringify({
      schemaVersion: 1,
      operationId: operation.operationId,
      planId: operation.planId,
      kind: operation.kind,
      state: operation.state,
      phase: operation.phase,
      progress: operation.progress,
      childCommands: operation.childCommands,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt
    }, null, 2);
  }

  planSessionPlacement(intent: CockpitPlaceSessionIntent): Promise<CockpitPlaceSessionPlan> {
    if (!this.supported) return Promise.reject(new Error('Session placement is unavailable.'));
    return ipc.cockpit.placementPlan(structuredClone(intent));
  }

  async executeSessionPlacement(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitPlaceSessionOperation> {
    if (!this.supported) throw new Error('Session placement is unavailable.');
    const operation = await ipc.cockpit.placementExecute(planId, [...acknowledgements]);
    await this.refresh();
    if (operation.result) {
      const projection = this.snapshot.sessions.find((candidate) =>
        candidate.ref.deviceId === operation.result!.sessionRef.deviceId
        && candidate.ref.sessionId === operation.result!.sessionRef.sessionId
      );
      if (projection) this.selectedSessionKey = projection.key;
    }
    return operation;
  }

  planWorkspaceAlignment(intent: CockpitAlignWorkspaceIntent): Promise<CockpitAlignWorkspacePlan> {
    if (!this.supported) return Promise.reject(new Error('Workspace alignment is unavailable.'));
    return ipc.cockpit.alignmentPlan(structuredClone(intent));
  }

  async executeWorkspaceAlignment(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitAlignWorkspaceOperation> {
    if (!this.supported) throw new Error('Workspace alignment is unavailable.');
    const operation = await ipc.cockpit.alignmentExecute(planId, [...acknowledgements]);
    await this.refresh();
    return operation;
  }

  planProjectPublication(intent: CockpitPublishProjectIntent): Promise<CockpitPublishProjectPlan> {
    if (!this.supported) return Promise.reject(new Error('Project publication is unavailable.'));
    return ipc.cockpit.publicationPlan(structuredClone(intent));
  }

  async executeProjectPublication(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitPublishProjectOperation> {
    if (!this.supported) throw new Error('Project publication is unavailable.');
    const operation = await ipc.cockpit.publicationExecute(planId, [...acknowledgements]);
    await this.refresh();
    return operation;
  }

  planSessionSourceLifecycle(
    intent: CockpitSessionSourceLifecycleIntent
  ): Promise<CockpitSessionSourceLifecyclePlan> {
    if (!this.supported) return Promise.reject(new Error('Session source lifecycle is unavailable.'));
    return ipc.cockpit.sourceLifecyclePlan(structuredClone(intent));
  }

  async executeSessionSourceLifecycle(
    planId: string,
    acknowledgements: string[]
  ): Promise<CockpitSessionSourceLifecycleOperation> {
    if (!this.supported) throw new Error('Session source lifecycle is unavailable.');
    const operation = await ipc.cockpit.sourceLifecycleExecute(planId, [...acknowledgements]);
    await this.refresh();
    return operation;
  }

  acquireTerminalOutput(
    terminalRef: TerminalRef,
    listener: (event: TerminalOutputEvent) => void
  ): { ready: Promise<void>; dispose(): void } {
    if (!this.supported) throw new Error('Multi-Device terminal attachment is unavailable.');
    const ref = structuredClone(terminalRef);
    const key = terminalRefKey(ref);
    const entry = this.terminalOutputListeners.get(key) ?? {
      ref,
      listeners: new Set<(event: TerminalOutputEvent) => void>()
    };
    entry.listeners.add(listener);
    this.terminalOutputListeners.set(key, entry);
    const ready = this.syncTerminalDemand();
    let active = true;
    return {
      ready,
      dispose: () => {
        if (!active) return;
        active = false;
        const current = this.terminalOutputListeners.get(key);
        current?.listeners.delete(listener);
        if (current?.listeners.size === 0) this.terminalOutputListeners.delete(key);
        void this.syncTerminalDemand().catch(() => undefined);
      }
    };
  }

  async terminalInput(terminalRef: TerminalRef, data: string): Promise<void> {
    await ipc.cockpit.terminalInput({ terminalRef, data });
  }

  async takeTerminalInputControl(terminalRef: TerminalRef): Promise<void> {
    const result = await ipc.cockpit.terminalInputLease({ terminalRef, takeover: true });
    this.inputLeaseEvents = {
      ...this.inputLeaseEvents,
      [terminalRefKey(result.terminalRef)]: {
        type: 'taken-over',
        terminalId: result.terminalRef.terminalId,
        lease: result.lease,
        observedAt: new Date().toISOString()
      }
    };
  }

  terminalInputLeaseEvent(terminalRef: TerminalRef): TerminalInputLeaseEvent | null {
    return this.inputLeaseEvents[terminalRefKey(terminalRef)] ?? null;
  }

  async terminalResize(terminalRef: TerminalRef, cols: number, rows: number): Promise<void> {
    await ipc.cockpit.terminalResize({ terminalRef, cols, rows });
  }

  terminalReplay(terminalRef: TerminalRef, afterSeq = 0): Promise<CockpitTerminalReplay> {
    return ipc.cockpit.terminalReplay({ terminalRef, afterSeq });
  }

  detach(): void {
    this.detachEvent?.();
    this.detachEvent = null;
  }

  private syncTerminalDemand(): Promise<void> {
    const refs = [...this.terminalOutputListeners.values()].map(({ ref }) => ref);
    this.demandSync = this.demandSync
      .catch(() => undefined)
      .then(async () => {
        await ipc.cockpit.setDemand({ terminalOutput: refs });
      });
    return this.demandSync;
  }

  private attach(): void {
    this.detach();
    this.detachEvent = ipc.cockpit.onEvent((event) => {
      this.applyEvent(event);
    });
  }

  private applyEvent(event: CockpitEvent): void {
    if (event.type === 'snapshot') {
      if (event.snapshot.revision >= this.snapshot.revision) {
        this.snapshot = event.snapshot;
        this.clearUnavailableSelection();
      }
      return;
    }
    if (event.type === 'device') {
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        devices: upsertBy(
          this.snapshot.devices,
          event.device,
          (device) => device.deviceId
        )
      };
      this.clearUnavailableSelection();
      return;
    }
    if (event.type === 'session.changed') {
      const target = event.session.session.archivedAt ? 'archivedSessions' : 'sessions';
      const other = target === 'sessions' ? 'archivedSessions' : 'sessions';
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        [target]: upsertBy(this.snapshot[target], event.session, (session) => session.key),
        [other]: this.snapshot[other].filter((session) => session.key !== event.session.key)
      };
      return;
    }
    if (event.type === 'session.deleted') {
      const key = `${event.ref.deviceId}/${encodeURIComponent(event.ref.sessionId)}`;
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        sessions: this.snapshot.sessions.filter((session) => session.key !== key),
        archivedSessions: this.snapshot.archivedSessions.filter((session) => session.key !== key)
      };
      return;
    }
    if (event.type === 'terminal.output') {
      const entry = this.terminalOutputListeners.get(terminalRefKey(event.terminalRef));
      if (!entry) return;
      for (const listener of entry.listeners) listener(event.event);
      return;
    }
    if (event.type === 'terminal.input-lease') {
      this.inputLeaseEvents = {
        ...this.inputLeaseEvents,
        [terminalRefKey(event.terminalRef)]: event.event
      };
      return;
    }
    if (event.type === 'terminal.status') {
      this.patchRuntime(event.sessionRef.deviceId, event.sessionRef.sessionId, {
        ...event.event
      });
      return;
    }
    if (event.type === 'terminal.exit') {
      this.patchRuntime(event.sessionRef.deviceId, event.sessionRef.sessionId, {
        sessionId: event.event.sessionId,
        terminalId: event.event.terminalId,
        status: 'exited',
        exitCode: event.event.exitCode,
        signal: event.event.signal
      });
      return;
    }
    if (event.type === 'terminal.location') {
      const projection = this.snapshot.sessions.find((session) =>
        session.ref.deviceId === event.sessionRef.deviceId
        && session.ref.sessionId === event.sessionRef.sessionId
      );
      if (!projection?.runtime) return;
      this.patchRuntime(event.sessionRef.deviceId, event.sessionRef.sessionId, {
        ...projection.runtime.state,
        cwd: event.event.cwd
      });
    }
  }

  private patchRuntime(
    deviceId: DeviceId,
    sessionId: string,
    state: SessionRuntimeState
  ): void {
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      sessions: this.snapshot.sessions.map((session) => {
        if (session.ref.deviceId !== deviceId || session.ref.sessionId !== sessionId) {
          return session;
        }
        return {
          ...session,
          runtime: {
            sessionRef: session.ref,
            terminalRef: state.terminalId
              ? { deviceId, terminalId: state.terminalId }
              : null,
            state
          }
        };
      })
    };
  }

  private clearUnavailableSelection(): void {
    if (!this.selectedSessionKey) return;
    const selected = this.snapshot.sessions.find(
      (session) => session.key === this.selectedSessionKey
    );
    const owner = selected ? this.device(selected.ref.deviceId) : null;
    if (!selected || owner?.state !== 'ready') this.selectedSessionKey = null;
  }
}

function upsertBy<T>(items: T[], value: T, key: (item: T) => string): T[] {
  return [...items.filter((item) => key(item) !== key(value)), value];
}

export const cockpit = new CockpitStore();
