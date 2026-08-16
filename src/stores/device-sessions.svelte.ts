import type {
  DeviceEventEnvelope,
  DeviceId,
  DevicePortForwardResult,
  TerminalRef
} from '@shared/types/devices.js';
import type {
  CreateMultiDeviceSessionRequest,
  DeviceTerminalReplay,
  MultiDeviceSessionCreationPlan,
  MultiDeviceSessionState,
  MultiDeviceSessionView
} from '@shared/types/multi-device-sessions.js';
import type { SessionRuntimeState, SessionUpdate } from '@shared/types/sessions.js';
import type { SpawnSpec } from '@shared/types/terminal.js';
import type { WorkspaceDirectoryListing } from '@shared/types/workspaces.js';
import type {
  TerminalExitEvent,
  TerminalInputLease,
  TerminalInputLeaseEvent,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import { terminalControlProof } from '@shared/types/terminal.js';
import { ipc } from '../lib/ipc';
import { sessions as localSessions } from './sessions.svelte';

const EMPTY_STATE: MultiDeviceSessionState = {
  revision: 0,
  capturedAt: new Date(0).toISOString(),
  devices: [],
  projects: [],
  unassigned: [],
  archivedSessions: []
};

export class DeviceSessionsStore {
  readonly supported = ipc.sessions.devicesSupported;
  state = $state<MultiDeviceSessionState>(structuredClone(EMPTY_STATE));
  loaded = $state(false);
  refreshing = $state(false);
  selectedSessionKey = $state<string | null>(null);
  selectedDeviceId = $state<DeviceId | null>(null);
  inputLeaseEvents = $state<Record<string, TerminalInputLeaseEvent>>({});
  ownedInputLeases = $state<Record<string, TerminalInputLease>>({});
  private detachState: (() => void) | null = null;
  private detachDeviceEvent: (() => void) | null = null;
  private loadRequest: Promise<void> | null = null;
  private readonly terminalOutputListeners = new Map<
    string,
    { ref: TerminalRef; listeners: Set<(event: TerminalOutputEvent) => void> }
  >();
  private readonly deviceReconnectListeners = new Map<DeviceId, Set<() => void>>();
  private demandSync: Promise<void> = Promise.resolve();

  get sessions(): MultiDeviceSessionView[] {
    return [
      ...this.state.projects.flatMap((project) =>
        project.workspaces.flatMap((workspace) => workspace.sessions)
      ),
      ...this.state.unassigned
    ];
  }

  get selectedProjection(): MultiDeviceSessionView | null {
    if (!this.selectedSessionKey) return null;
    return this.sessions.find((session) => session.key === this.selectedSessionKey) ?? null;
  }

  get localDevice() {
    return this.state.devices.find((device) => device.local) ?? null;
  }

  device(deviceId: DeviceId) {
    return this.state.devices.find((device) => device.deviceId === deviceId) ?? null;
  }

  setDeviceFilter(deviceId: DeviceId | null): void {
    if (deviceId && !this.device(deviceId)) return;
    this.selectedDeviceId = deviceId;
    const selected = this.selectedProjection;
    if (selected && !this.includesDevice(selected.ref.deviceId)) this.clearSelectedSession();
    if (localSessions.selected && !this.includesDevice(this.localDevice?.deviceId ?? null)) {
      localSessions.select(null);
    }
  }

  includesDevice(deviceId: DeviceId | null): boolean {
    return this.selectedDeviceId === null || this.selectedDeviceId === deviceId;
  }

  isSelected(projection: MultiDeviceSessionView): boolean {
    const owner = this.device(projection.ref.deviceId);
    return owner?.local
      ? localSessions.selectedId === projection.ref.sessionId
      : this.selectedSessionKey === projection.key;
  }

  localTerminalRef(terminalId: string): TerminalRef | null {
    const deviceId = this.localDevice?.deviceId;
    return deviceId ? { deviceId, terminalId } : null;
  }

  selectSession(key: string): void {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return;
    const owner = this.device(projection.ref.deviceId);
    if (!owner?.available) return;
    if (owner.local) {
      this.selectedSessionKey = null;
      localSessions.select(projection.ref.sessionId);
      return;
    }
    localSessions.select(null);
    this.selectedSessionKey = key;
  }

  async openSession(key: string): Promise<void> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return;
    const owner = this.device(projection.ref.deviceId);
    if (!owner?.available) return;
    if (owner.local) {
      this.selectSession(key);
      return;
    }
    if (!projection.runtime?.terminalId || projection.runtime.status !== 'running') {
      await ipc.sessions.startOnDevice(projection.ref);
      await this.refresh();
    }
    const refreshed = this.sessions.find((candidate) => candidate.key === key);
    if (refreshed?.available && refreshed.runtime?.terminalId) {
      this.selectedSessionKey = key;
    }
  }

  async stopSession(key: string): Promise<void> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    const terminalId = projection?.runtime?.terminalId;
    if (!projection?.available || !terminalId) return;
    await ipc.sessions.deviceTerminalStop({
      deviceId: projection.ref.deviceId,
      terminalId
    });
    await this.refresh();
  }

  async restartSession(key: string): Promise<void> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return;
    if (projection.runtime?.terminalId) {
      await ipc.sessions.deviceTerminalStop({
        deviceId: projection.ref.deviceId,
        terminalId: projection.runtime.terminalId
      });
    }
    await ipc.sessions.startOnDevice(projection.ref);
    await this.refresh();
    this.selectedSessionKey = key;
  }

  async updateSession(key: string, patch: SessionUpdate): Promise<void> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return;
    const owner = this.device(projection.ref.deviceId);
    if (!owner?.available) return;
    if (owner.local) {
      await localSessions.update(projection.ref.sessionId, structuredClone(patch));
      return;
    }
    await ipc.sessions.updateOnDevice(projection.ref, structuredClone(patch));
  }

  async deleteSession(key: string): Promise<void> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return;
    const owner = this.device(projection.ref.deviceId);
    if (!owner?.available) return;
    if (owner.local) {
      await localSessions.remove(projection.ref.sessionId);
    } else {
      await ipc.sessions.deleteOnDevice(projection.ref);
    }
    if (this.selectedSessionKey === key) this.clearSelectedSession();
  }

  previewCommand(key: string): Promise<SpawnSpec> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return Promise.reject(new Error('Session is unavailable.'));
    const owner = this.device(projection.ref.deviceId);
    if (!owner?.available) return Promise.reject(new Error('Session Device is unavailable.'));
    return owner.local
      ? ipc.sessions.previewCommand(projection.ref.sessionId)
      : ipc.sessions.previewCommandOnDevice(projection.ref);
  }

  ensureTailscalePort(
    deviceId: DeviceId,
    port: number
  ): Promise<DevicePortForwardResult> {
    const device = this.device(deviceId);
    if (!device?.available) {
      return Promise.reject(new Error('The selected Device is unavailable.'));
    }
    return ipc.sessions.ensureDeviceTailscalePort(deviceId, port);
  }

  clearSelectedSession(): void {
    this.selectedSessionKey = null;
  }

  load(): Promise<void> {
    if (!this.supported) {
      this.loaded = true;
      return Promise.resolve();
    }
    if (this.loadRequest) return this.loadRequest;
    this.loadRequest = ipc.sessions.deviceState()
      .then((state) => {
        this.state = state;
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
      this.applyState(await ipc.sessions.refreshDevices());
    } finally {
      this.refreshing = false;
    }
  }

  async reorder(ordered: MultiDeviceSessionView[]): Promise<void> {
    this.applyState(await ipc.sessions.reorderOnDevices(
      ordered.map((projection) => structuredClone(projection.ref))
    ));
  }

  async create(request: CreateMultiDeviceSessionRequest): Promise<MultiDeviceSessionView> {
    const created = await ipc.sessions.createOnDevice(structuredClone(request));
    await this.refresh();
    this.selectSession(created.key);
    return created;
  }

  planCreate(
    request: CreateMultiDeviceSessionRequest
  ): Promise<MultiDeviceSessionCreationPlan> {
    return ipc.sessions.planCreateOnDevice(structuredClone(request));
  }

  async executeCreate(planId: string): Promise<MultiDeviceSessionView> {
    const created = await ipc.sessions.executeCreateOnDevice(planId);
    await this.refresh();
    this.selectSession(created.key);
    return created;
  }

  browseWorkspaceDirectories(
    deviceId: DeviceId,
    path?: string
  ): Promise<WorkspaceDirectoryListing> {
    return ipc.sessions.browseDeviceWorkspaceDirectories({
      deviceId,
      ...(path ? { path } : {})
    });
  }

  async openProjectOnDevice(
    deviceId: DeviceId,
    project: import('@shared/types/projects.js').ProjectOpenRequest
  ): Promise<void> {
    this.state = await ipc.sessions.openProjectOnDevice({ deviceId, project });
  }

  async executePreparation(planId: string): Promise<void> {
    this.state = await ipc.sessions.executeDevicePreparation(planId);
  }

  acquireTerminalOutput(
    terminalRef: TerminalRef,
    listener: (event: TerminalOutputEvent) => void
  ): { ready: Promise<void>; dispose(): void } {
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

  onDeviceReconnect(deviceId: DeviceId, listener: () => void): () => void {
    const listeners = this.deviceReconnectListeners.get(deviceId) ?? new Set<() => void>();
    listeners.add(listener);
    this.deviceReconnectListeners.set(deviceId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.deviceReconnectListeners.delete(deviceId);
    };
  }

  terminalInput(terminalRef: TerminalRef, data: string): Promise<void> {
    const lease = this.ownedInputLeases[terminalRefKey(terminalRef)];
    if (!lease) return Promise.reject(new Error('Terminal control lease is required.'));
    return ipc.sessions.deviceTerminalInput(
      terminalRef,
      data,
      terminalControlProof(lease)
    ).then(() => undefined);
  }

  async claimTerminalInputControl(
    terminalRef: TerminalRef,
    takeover = false
  ): Promise<boolean> {
    try {
      const lease = await ipc.sessions.deviceTerminalInputLease(terminalRef, takeover);
      const key = terminalRefKey(terminalRef);
      const previous = this.inputLeaseEvents[key]?.lease;
      this.ownedInputLeases = { ...this.ownedInputLeases, [key]: lease };
      this.inputLeaseEvents = {
        ...this.inputLeaseEvents,
        [key]: {
          type: takeover && previous?.controllerDeviceId !== lease.controllerDeviceId
            ? 'taken-over'
            : 'acquired',
          terminalId: terminalRef.terminalId,
          lease,
          previousControllerDeviceId: previous?.controllerDeviceId,
          observedAt: new Date().toISOString()
        }
      };
      return true;
    } catch {
      await this.refreshTerminalInputLease(terminalRef).catch(() => null);
      return false;
    }
  }

  async takeTerminalInputControl(terminalRef: TerminalRef): Promise<void> {
    await this.claimTerminalInputControl(terminalRef, true);
  }

  async refreshTerminalInputLease(terminalRef: TerminalRef): Promise<TerminalInputLease | null> {
    const lease = await ipc.sessions.deviceTerminalCurrentInputLease(terminalRef);
    const key = terminalRefKey(terminalRef);
    this.inputLeaseEvents = {
      ...this.inputLeaseEvents,
      [key]: {
        type: lease ? 'acquired' : 'released',
        terminalId: terminalRef.terminalId,
        lease,
        observedAt: new Date().toISOString()
      }
    };
    if (this.ownedInputLeases[key]?.leaseId !== lease?.leaseId) {
      const controlledHere = lease?.controllerDeviceId === this.localDevice?.deviceId
        ? lease
        : null;
      if (controlledHere) {
        this.ownedInputLeases = { ...this.ownedInputLeases, [key]: controlledHere };
      } else {
        const remaining = { ...this.ownedInputLeases };
        delete remaining[key];
        this.ownedInputLeases = remaining;
      }
    }
    return lease;
  }

  ownsTerminalInput(terminalRef: TerminalRef): boolean {
    const key = terminalRefKey(terminalRef);
    const owned = this.ownedInputLeases[key];
    const observed = this.inputLeaseEvents[key]?.lease;
    return Boolean(owned && observed?.leaseId === owned.leaseId);
  }

  async releaseTerminalInputControl(terminalRef: TerminalRef): Promise<void> {
    const key = terminalRefKey(terminalRef);
    const lease = this.ownedInputLeases[key];
    if (!lease) return;
    const remaining = { ...this.ownedInputLeases };
    delete remaining[key];
    this.ownedInputLeases = remaining;
    this.inputLeaseEvents = {
      ...this.inputLeaseEvents,
      [key]: {
        type: 'released',
        terminalId: terminalRef.terminalId,
        lease: null,
        previousControllerDeviceId: lease.controllerDeviceId,
        observedAt: new Date().toISOString()
      }
    };
    await ipc.sessions.deviceTerminalReleaseInputLease(
      terminalRef,
      terminalControlProof(lease)
    );
  }

  terminalInputLeaseEvent(terminalRef: TerminalRef): TerminalInputLeaseEvent | null {
    return this.inputLeaseEvents[terminalRefKey(terminalRef)] ?? null;
  }

  terminalResize(terminalRef: TerminalRef, cols: number, rows: number): Promise<void> {
    const lease = this.ownedInputLeases[terminalRefKey(terminalRef)];
    if (!lease) return Promise.reject(new Error('Terminal control lease is required.'));
    return ipc.sessions.deviceTerminalResize(
      terminalRef,
      cols,
      rows,
      terminalControlProof(lease)
    ).then(() => undefined);
  }

  terminalReplay(terminalRef: TerminalRef, afterSeq = 0): Promise<DeviceTerminalReplay> {
    return ipc.sessions.deviceTerminalReplay(terminalRef, afterSeq);
  }

  terminalStop(terminalRef: TerminalRef): Promise<void> {
    return ipc.sessions.deviceTerminalStop(terminalRef).then(() => undefined);
  }

  detach(): void {
    this.detachState?.();
    this.detachState = null;
    this.detachDeviceEvent?.();
    this.detachDeviceEvent = null;
  }

  private syncTerminalDemand(): Promise<void> {
    const refs = [...this.terminalOutputListeners.values()].map(({ ref }) => ref);
    this.demandSync = this.demandSync
      .catch(() => undefined)
      .then(() => ipc.sessions.setDeviceTerminalDemand(refs).then(() => undefined));
    return this.demandSync;
  }

  private attach(): void {
    this.detach();
    this.detachState = ipc.sessions.onDeviceStateChange((state) => {
      if (state.revision < this.state.revision) return;
      this.applyState(state);
    });
    this.detachDeviceEvent = ipc.sessions.onDeviceEvent((event) => this.applyDeviceEvent(event));
  }

  private applyState(state: MultiDeviceSessionState): void {
    const previousAvailability = new Map(
      this.state.devices.map((device) => [device.deviceId, device.available] as const)
    );
    const reconnected = state.devices
      .filter((device) => device.available && previousAvailability.get(device.deviceId) === false)
      .map((device) => device.deviceId);
    this.state = state;
    this.clearUnavailableSelection();
    for (const deviceId of reconnected) {
      for (const listener of [...(this.deviceReconnectListeners.get(deviceId) ?? [])]) {
        listener();
      }
    }
  }

  private applyDeviceEvent(envelope: DeviceEventEnvelope): void {
    if (envelope.event === 'output') {
      const event = terminalEvent<TerminalOutputEvent>(envelope.payload);
      if (!event) return;
      const entry = this.terminalOutputListeners.get(terminalRefKey({
        deviceId: envelope.deviceId,
        terminalId: event.terminalId
      }));
      if (!entry) return;
      for (const listener of entry.listeners) listener(event);
      return;
    }
    if (envelope.event === 'inputLease') {
      const event = terminalEvent<TerminalInputLeaseEvent>(envelope.payload);
      if (!event) return;
      const key = terminalRefKey({ deviceId: envelope.deviceId, terminalId: event.terminalId });
      this.inputLeaseEvents = {
        ...this.inputLeaseEvents,
        [key]: event
      };
      if (this.ownedInputLeases[key]?.leaseId !== event.lease?.leaseId) {
        const controlledHere = event.lease?.controllerDeviceId === this.localDevice?.deviceId
          ? event.lease
          : null;
        if (controlledHere) {
          this.ownedInputLeases = {
            ...this.ownedInputLeases,
            [key]: structuredClone(controlledHere)
          };
        } else {
          const remaining = { ...this.ownedInputLeases };
          delete remaining[key];
          this.ownedInputLeases = remaining;
        }
      }
      return;
    }
    if (envelope.event === 'status') {
      const event = terminalStatusEvent(envelope.payload);
      if (event) this.patchRuntime(envelope.deviceId, event.sessionId, event);
      return;
    }
    if (envelope.event === 'exit') {
      const event = terminalEvent<TerminalExitEvent>(envelope.payload);
      if (!event) return;
      this.patchRuntime(envelope.deviceId, event.sessionId, {
        sessionId: event.sessionId,
        terminalId: event.terminalId,
        status: 'exited',
        exitCode: event.exitCode,
        signal: event.signal
      });
      return;
    }
    if (envelope.event === 'location') {
      const event = terminalEvent<TerminalLocationEvent>(envelope.payload);
      if (!event) return;
      const current = this.sessions.find((session) =>
        session.ref.deviceId === envelope.deviceId
        && session.ref.sessionId === event.sessionId
      )?.runtime;
      if (current) this.patchRuntime(envelope.deviceId, event.sessionId, { ...current, cwd: event.cwd });
    }
  }

  private patchRuntime(deviceId: DeviceId, sessionId: string, runtime: SessionRuntimeState): void {
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      projects: this.state.projects.map((project) => ({
        ...project,
        workspaces: project.workspaces.map((workspace) => ({
          ...workspace,
          sessions: workspace.sessions.map((projection) =>
            projection.ref.deviceId === deviceId && projection.ref.sessionId === sessionId
              ? { ...projection, runtime: structuredClone(runtime) }
              : projection
          )
        }))
      })),
      unassigned: this.state.unassigned.map((projection) =>
        projection.ref.deviceId === deviceId && projection.ref.sessionId === sessionId
          ? { ...projection, runtime: structuredClone(runtime) }
          : projection
      )
    };
  }

  private clearUnavailableSelection(): void {
    if (this.selectedDeviceId && !this.device(this.selectedDeviceId)) {
      this.selectedDeviceId = null;
    }
    if (!this.selectedSessionKey) return;
    const selected = this.sessions.find((session) => session.key === this.selectedSessionKey);
    if (!selected) this.selectedSessionKey = null;
  }
}

function terminalRefKey(ref: TerminalRef): string {
  return `${ref.deviceId}/${encodeURIComponent(ref.terminalId)}`;
}

function terminalEvent<T extends { terminalId: string }>(value: unknown): T | null {
  if (!value || typeof value !== 'object') return null;
  const terminalId = (value as { terminalId?: unknown }).terminalId;
  return typeof terminalId === 'string' && terminalId ? value as T : null;
}

function terminalStatusEvent(value: unknown): TerminalStatusEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as { sessionId?: unknown; terminalId?: unknown };
  if (typeof event.sessionId !== 'string' || !event.sessionId) return null;
  if (event.terminalId !== null && typeof event.terminalId !== 'string') return null;
  return value as TerminalStatusEvent;
}

export const deviceSessions = new DeviceSessionsStore();
