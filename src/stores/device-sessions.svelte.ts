import type {
  DeviceEventEnvelope,
  DeviceId,
  DevicePortForwardResult,
  TerminalRef
} from '@shared/types/devices.js';
import type {
  CreateMultiDeviceSessionRequest,
  MultiDeviceSessionCreationPlan,
  MultiDeviceSessionState,
  MultiDeviceSessionView
} from '@shared/types/multi-device-sessions.js';
import type {
  AgentRuntimeProvider,
  Session,
  SessionLaunch,
  SessionRuntimeState,
  SessionUpdate
} from '@shared/types/sessions.js';
import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type { ClipboardImagePayload, ImagePasteResult } from '@shared/types/files.js';
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
import { worktreeScope, type WorktreeScope } from '@shared/worktree-identity.js';
import { ipc } from '../lib/ipc';
import { sendBracketedPasteWithInput } from '../lib/terminal-paste';
import { sessions as localSessions } from './sessions.svelte';

export type DeviceSessionPendingOperation =
  | 'starting'
  | 'stopping'
  | 'restarting'
  | 'updating'
  | 'deleting';

interface QueuedSessionUpdate {
  ref: MultiDeviceSessionView['ref'];
  patch: SessionUpdate;
  pendingToken: number;
  resolve(): void;
  reject(error: unknown): void;
}

interface SessionUpdateQueue {
  base: MultiDeviceSessionView['session'];
  entries: QueuedSessionUpdate[];
  running: boolean;
}

interface QueuedTerminalInput {
  data: string;
  resolve(): void;
  reject(error: unknown): void;
}

interface TerminalInputQueue {
  ref: TerminalRef;
  entries: QueuedTerminalInput[];
  running: boolean;
}

interface PendingSessionReorder {
  sequence: number;
  orderedKeys: string[];
  rollbackState: MultiDeviceSessionState;
}

const EMPTY_STATE: MultiDeviceSessionState = {
  revision: 0,
  capturedAt: new Date(0).toISOString(),
  devices: [],
  projects: [],
  unassigned: [],
  archivedSessions: []
};

export class DeviceSessionsStore {
  readonly supported = ipc.sessions?.devicesSupported ?? false;
  state = $state<MultiDeviceSessionState>(structuredClone(EMPTY_STATE));
  loaded = $state(false);
  refreshing = $state(false);
  selectedSessionKey = $state<string | null>(null);
  selectedDeviceId = $state<DeviceId | null>(null);
  inputLeaseEvents = $state<Record<string, TerminalInputLeaseEvent>>({});
  ownedInputLeases = $state<Record<string, TerminalInputLease>>({});
  pendingOperations = $state<Record<string, DeviceSessionPendingOperation>>({});
  private detachState: (() => void) | null = null;
  private detachDeviceEvent: (() => void) | null = null;
  private loadRequest: Promise<void> | null = null;
  private refreshRequest: Promise<void> | null = null;
  private readonly terminalOutputListeners = new Map<
    string,
    { ref: TerminalRef; listeners: Set<(event: TerminalOutputEvent) => void> }
  >();
  private readonly deviceReconnectListeners = new Map<DeviceId, Set<() => void>>();
  private readonly terminalInputQueues = new Map<string, TerminalInputQueue>();
  private demandSync: Promise<void> = Promise.resolve();
  private pendingSequence = 0;
  private reorderSequence = 0;
  private pendingReorder: PendingSessionReorder | null = null;
  private reorderPersistence: Promise<void> = Promise.resolve();
  private authoritativeGeneration = 0;
  private readonly pendingBySession = new Map<
    string,
    Map<number, DeviceSessionPendingOperation>
  >();
  private readonly sessionUpdateQueues = new Map<string, SessionUpdateQueue>();

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
    const projection = this.sessions.find((session) => session.key === this.selectedSessionKey) ?? null;
    return this.multiDeviceActive ? projection : null;
  }

  get activeSession(): Session | null {
    return this.selectedProjection?.session ?? localSessions.selected;
  }

  get activeDeviceId(): DeviceId | null {
    const projection = this.selectedProjection;
    if (projection) return projection.ref.deviceId;
    return localSessions.selected ? this.localDevice?.deviceId ?? null : null;
  }

  get activeRemoteDeviceId(): DeviceId | null {
    const projection = this.selectedProjection;
    if (!projection) return null;
    return this.device(projection.ref.deviceId)?.local ? null : projection.ref.deviceId;
  }

  get activeWorktreeScope(): WorktreeScope | null {
    const session = this.activeSession;
    if (!session?.cwd?.trim()) return null;
    return worktreeScope(session.cwd, {
      runMode: session.runMode,
      ...(session.wslDistro ? { wslDistro: session.wslDistro } : {}),
      ...(this.activeRemoteDeviceId ? { deviceId: this.activeRemoteDeviceId } : {})
    });
  }

  get activeWorkspace() {
    const projection = this.selectedProjection;
    if (!projection) return null;
    return this.state.projects
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.sessions.some((session) => session.key === projection.key))
      ?? null;
  }

  get activeProject() {
    const workspace = this.activeWorkspace;
    if (!workspace) return null;
    return this.state.projects.find((project) => project.workspaces.includes(workspace)) ?? null;
  }

  get localDevice() {
    return this.state.devices.find((device) => device.local) ?? null;
  }

  /**
   * Multi-Device UI is progressive: API support and the local Device alone do
   * not change the local-only experience. The backend removes remote Devices
   * when Connections are disabled, so a remote Device here is the activation
   * signal shared by every renderer entry point.
   */
  get multiDeviceActive(): boolean {
    return this.state.devices.some((device) => !device.local);
  }

  get visibleDevices() {
    return this.multiDeviceActive
      ? this.state.devices
      : this.state.devices.filter((device) => device.local);
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
    if (!this.multiDeviceActive) return deviceId === this.localDevice?.deviceId;
    return this.selectedDeviceId === null || this.selectedDeviceId === deviceId;
  }

  isSelected(projection: MultiDeviceSessionView): boolean {
    const owner = this.device(projection.ref.deviceId);
    return owner?.local
      ? localSessions.selectedId === projection.ref.sessionId
      : this.selectedSessionKey === projection.key;
  }

  pendingOperation(key: string): DeviceSessionPendingOperation | null {
    return this.pendingOperations[key] ?? null;
  }

  localTerminalRef(terminalId: string): TerminalRef | null {
    const deviceId = this.localDevice?.deviceId;
    return deviceId ? { deviceId, terminalId } : null;
  }

  selectSession(key: string): void {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection) return;
    const owner = this.device(projection.ref.deviceId);
    if (!owner) return;
    const reconnect = !projection.available || !owner.available;
    if (owner.local) {
      this.selectedSessionKey = null;
      localSessions.select(projection.ref.sessionId);
      if (reconnect) void this.refreshAfterCurrent().catch(() => undefined);
      return;
    }
    localSessions.select(null);
    this.selectedSessionKey = key;
    if (reconnect) void this.refreshAfterCurrent().catch(() => undefined);
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
    if (projection.runtime?.terminalId && projection.runtime.status === 'running') {
      this.selectSession(key);
      return;
    }
    const previousSelection = this.selectedSessionKey;
    const pending = this.beginPending(key, 'starting');
    const ref = $state.snapshot(projection.ref);
    this.selectedSessionKey = key;
    try {
      const started = await ipc.sessions.startOnDevice(ref);
      if (this.isLatestPending(key, pending)) this.replaceProjection(started);
    } catch (error) {
      if (this.isLatestPending(key, pending) && this.selectedSessionKey === key) {
        this.selectedSessionKey = previousSelection;
      }
      throw error;
    } finally {
      this.endPending(key, pending);
    }
  }

  async stopSession(key: string): Promise<void> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    const terminalId = projection?.runtime?.terminalId;
    if (!projection?.available || !terminalId) return;
    const pending = this.beginPending(key, 'stopping');
    try {
      await ipc.sessions.deviceTerminalStop({
        deviceId: projection.ref.deviceId,
        terminalId
      });
      await this.refreshAfterCurrent();
    } finally {
      this.endPending(key, pending);
    }
  }

  async restartSession(key: string): Promise<void> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return;
    const pending = this.beginPending(key, 'restarting');
    const ref = $state.snapshot(projection.ref);
    let stopped = false;
    try {
      if (projection.runtime?.terminalId) {
        await ipc.sessions.deviceTerminalStop({
          deviceId: projection.ref.deviceId,
          terminalId: projection.runtime.terminalId
        });
        stopped = true;
      }
      const restarted = await ipc.sessions.startOnDevice(ref);
      if (this.isLatestPending(key, pending)) this.replaceProjection(restarted);
      this.selectedSessionKey = key;
    } catch (error) {
      if (stopped) await this.refreshAfterCurrent().catch(() => undefined);
      throw error;
    } finally {
      this.endPending(key, pending);
    }
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
    return this.enqueueSessionUpdate(key, projection, patch);
  }

  async deleteSession(key: string): Promise<void> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return;
    const owner = this.device(projection.ref.deviceId);
    if (!owner?.available) return;
    if (owner.local) {
      await localSessions.remove(projection.ref.sessionId);
      return;
    }
    const ref = $state.snapshot(projection.ref);
    const pending = this.beginPending(key, 'deleting');
    try {
      const state = await ipc.sessions.deleteOnDevice(ref);
      this.applyState(state);
    } finally {
      this.endPending(key, pending);
    }
  }

  previewCommand(key: string): Promise<SpawnSpec> {
    const projection = this.sessions.find((candidate) => candidate.key === key);
    if (!projection?.available) return Promise.reject(new Error('Session is unavailable.'));
    const owner = this.device(projection.ref.deviceId);
    if (!owner?.available) return Promise.reject(new Error('Session Device is unavailable.'));
    return owner.local
      ? ipc.sessions.previewCommand(projection.ref.sessionId)
      : ipc.sessions.previewCommandOnDevice($state.snapshot(projection.ref));
  }

  ensureTailscalePort(
    deviceId: DeviceId,
    port: number,
    virtualHostname?: string
  ): Promise<DevicePortForwardResult> {
    const device = this.device(deviceId);
    if (!device?.available) {
      return Promise.reject(new Error('The selected Device is unavailable.'));
    }
    return ipc.sessions.ensureDeviceTailscalePort(deviceId, port, virtualHostname);
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

  refresh(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (this.refreshRequest) return this.refreshRequest;
    this.refreshing = true;
    const request = ipc.sessions.refreshDevices()
      .then((state) => {
        if (state.revision < this.state.revision) return;
        this.applyState(state);
      })
      .finally(() => {
        this.refreshing = false;
        if (this.refreshRequest === request) this.refreshRequest = null;
      });
    this.refreshRequest = request;
    return request;
  }

  async reorder(ordered: MultiDeviceSessionView[]): Promise<void> {
    const previous = $state.snapshot(this.state);
    const sequence = ++this.reorderSequence;
    const keys = ordered.map((projection) => projection.key);
    this.pendingReorder = { sequence, orderedKeys: keys, rollbackState: previous };
    this.state = stateWithOptimisticSessionOrder(previous, keys);
    try {
      const refs = ordered.map((projection) => $state.snapshot(projection.ref));
      const persistence = this.reorderPersistence
        .catch(() => undefined)
        .then(() => ipc.sessions.reorderOnDevices(refs));
      this.reorderPersistence = persistence.then(() => undefined, () => undefined);
      const state = await persistence;
      if (sequence === this.pendingReorder?.sequence) {
        this.pendingReorder = null;
        this.applyState(state);
      }
    } catch (error) {
      if (sequence === this.pendingReorder?.sequence) {
        const rollback = this.pendingReorder.rollbackState;
        this.pendingReorder = null;
        this.state = rollback;
        this.reapplyPendingSessionUpdates();
        this.clearUnavailableSelection();
      }
      throw error;
    }
  }

  async create(
    request: CreateMultiDeviceSessionRequest,
    select = true
  ): Promise<MultiDeviceSessionView> {
    const created = await ipc.sessions.createOnDevice(structuredClone(request));
    if (!this.sessions.some((projection) => projection.key === created.key)) await this.refresh();
    if (select) this.selectCreatedProjection(created);
    return created;
  }

  workspaceKeyForSession(key: string): string | null {
    for (const project of this.state.projects) {
      for (const workspace of project.workspaces) {
        if (workspace.sessions.some((projection) => projection.key === key)) return workspace.key;
      }
    }
    return null;
  }

  async createBeside(
    originKey: string,
    input: {
      name: string;
      launch: SessionLaunch;
      continuationPrompt?: string;
      continuationProvider?: AgentRuntimeProvider;
    }
  ): Promise<MultiDeviceSessionView> {
    const origin = this.sessions.find((projection) => projection.key === originKey);
    if (!origin) throw new Error(`Session not found: ${originKey}`);
    const workspaceKey = this.workspaceKeyForSession(originKey);
    const created = await this.create({
      workspaceKey,
      targetDeviceId: origin.ref.deviceId,
      ...(workspaceKey === null ? { targetPath: origin.session.cwd } : {}),
      session: { name: input.name, launch: structuredClone(input.launch) }
    }, false);

    try {
      if (input.continuationPrompt) {
        const terminalId = created.runtime?.terminalId;
        if (!terminalId) throw new Error(`Terminal did not start for ${created.session.name}`);
        const terminalRef = { deviceId: created.ref.deviceId, terminalId };
        const claimed = await this.claimTerminalInputControl(terminalRef);
        if (!claimed) throw new Error('Could not acquire control of the new Session terminal.');
        await sendBracketedPasteWithInput(
          (data) => this.terminalInput(terminalRef, data),
          input.continuationPrompt,
          true,
          input.continuationProvider
        );
      }
      return created;
    } finally {
      this.selectSession(created.key);
    }
  }

  planCreate(
    request: CreateMultiDeviceSessionRequest
  ): Promise<MultiDeviceSessionCreationPlan> {
    return ipc.sessions.planCreateOnDevice(structuredClone(request));
  }

  async executeCreate(planId: string): Promise<MultiDeviceSessionView> {
    const created = await ipc.sessions.executeCreateOnDevice(planId);
    if (!this.sessions.some((projection) => projection.key === created.key)) await this.refresh();
    this.selectCreatedProjection(created);
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
    this.applyState(await ipc.sessions.openProjectOnDevice({ deviceId, project }));
  }

  async executePreparation(planId: string): Promise<void> {
    this.applyState(await ipc.sessions.executeDevicePreparation(planId));
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
    const key = terminalRefKey(terminalRef);
    let queue = this.terminalInputQueues.get(key);
    if (!queue) {
      queue = { ref: structuredClone(terminalRef), entries: [], running: false };
      this.terminalInputQueues.set(key, queue);
    }
    const currentQueue = queue;
    const result = new Promise<void>((resolve, reject) => {
      currentQueue.entries.push({ data, resolve, reject });
    });
    if (!currentQueue.running) {
      currentQueue.running = true;
      queueMicrotask(() => void this.drainTerminalInput(key, currentQueue));
    }
    return result;
  }

  private async drainTerminalInput(key: string, queue: TerminalInputQueue): Promise<void> {
    while (queue.entries.length > 0) {
      const batch = queue.entries.splice(0);
      try {
        await this.sendTerminalInput(
          queue.ref,
          key,
          batch.map((entry) => entry.data).join('')
        );
        for (const entry of batch) entry.resolve();
      } catch (error) {
        for (const entry of batch) entry.reject(error);
      }
    }
    queue.running = false;
    if (this.terminalInputQueues.get(key) === queue) this.terminalInputQueues.delete(key);
  }

  private async sendTerminalInput(
    terminalRef: TerminalRef,
    key: string,
    data: string
  ): Promise<void> {
    let lease = this.ownedInputLeases[key];
    if (!lease) {
      const recovered = await this.claimTerminalInputControl(terminalRef);
      lease = this.ownedInputLeases[key];
      if (!recovered || !lease) throw new Error('Terminal control lease is required.');
    }
    try {
      await ipc.sessions.deviceTerminalInput(terminalRef, data, terminalControlProof(lease));
      return;
    } catch (error) {
      if (!isRecoverableTerminalControlError(error)) throw error;
    }
    const recovered = await this.claimTerminalInputControl(terminalRef);
    const current = this.ownedInputLeases[key];
    if (!recovered || !current) throw new Error('Terminal control lease is required.');
    await ipc.sessions.deviceTerminalInput(
      terminalRef,
      data,
      terminalControlProof(current)
    );
  }

  async pasteImagesIntoTerminal(
    terminalRef: TerminalRef,
    sessionId: string,
    images: ClipboardImagePayload[]
  ): Promise<ImagePasteResult> {
    const key = terminalRefKey(terminalRef);
    let lease = this.ownedInputLeases[key];
    if (!lease) {
      const recovered = await this.claimTerminalInputControl(terminalRef);
      lease = this.ownedInputLeases[key];
      if (!recovered || !lease) throw new Error('Terminal control lease is required.');
    }
    try {
      return await ipc.sessions.deviceTerminalPasteImages(
        terminalRef,
        sessionId,
        images,
        terminalControlProof(lease)
      );
    } catch (error) {
      if (!isRecoverableTerminalControlError(error)) throw error;
      const recovered = await this.claimTerminalInputControl(terminalRef);
      const current = this.ownedInputLeases[key];
      if (!recovered || !current) throw error;
      return ipc.sessions.deviceTerminalPasteImages(
        terminalRef,
        sessionId,
        images,
        terminalControlProof(current)
      );
    }
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
    await ipc.sessions.deviceTerminalParkInputLease(
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

  terminalHistory(terminalRef: TerminalRef) {
    return ipc.sessions.deviceTerminalHistory(terminalRef);
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
    this.authoritativeGeneration += 1;
    this.state = state;
    if (this.pendingReorder) {
      this.pendingReorder.rollbackState = $state.snapshot(state);
      this.state = stateWithOptimisticSessionOrder(
        $state.snapshot(this.state),
        this.pendingReorder.orderedKeys
      );
    }
    this.reapplyPendingSessionUpdates();
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
      this.patchProjectionByRef(envelope.deviceId, event.sessionId, (projection) => ({
        ...projection,
        lifecycleStatus: 'exited',
        runtime: null
      }));
      return;
    }
    if (envelope.event === 'observer.snapshot') {
      const snapshot = observedAgentSnapshot(envelope.payload);
      if (!snapshot || snapshot.subjectKind !== 'session') return;
      const sessionId = snapshot.sessionId ?? snapshot.id;
      this.patchObservation(envelope.deviceId, sessionId, snapshot);
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
    this.patchProjectionByRef(deviceId, sessionId, (projection) => ({
      ...projection,
      lifecycleStatus: runtime.status,
      runtime: structuredClone({ ...projection.runtime, ...runtime })
    }));
  }

  private patchObservation(
    deviceId: DeviceId,
    sessionId: string,
    observation: ObservedAgentSnapshot
  ): void {
    this.patchProjectionByRef(deviceId, sessionId, (projection) => ({
      ...projection,
      observation: structuredClone(observation)
    }));
  }

  private patchProjectionByRef(
    deviceId: DeviceId,
    sessionId: string,
    update: (projection: MultiDeviceSessionView) => MultiDeviceSessionView
  ): void {
    this.patchAllProjections((projection) =>
      projection.ref.deviceId === deviceId && projection.ref.sessionId === sessionId
        ? update(projection)
        : projection
    );
  }

  private patchProjection(
    key: string,
    update: (projection: MultiDeviceSessionView) => MultiDeviceSessionView
  ): void {
    this.patchAllProjections((projection) => projection.key === key ? update(projection) : projection);
  }

  private replaceProjection(projection: MultiDeviceSessionView): void {
    this.patchProjection(projection.key, () => structuredClone({
      ...projection,
      lifecycleStatus: projection.lifecycleStatus ?? projection.runtime?.status ?? 'stopped'
    }));
  }

  private selectCreatedProjection(projection: MultiDeviceSessionView): void {
    if (this.device(projection.ref.deviceId)?.local) {
      this.selectedSessionKey = null;
      localSessions.select(projection.ref.sessionId);
      return;
    }
    localSessions.select(null);
    this.selectedSessionKey = projection.key;
  }

  private patchAllProjections(
    patch: (projection: MultiDeviceSessionView) => MultiDeviceSessionView,
    removeKey: string | null = null
  ): void {
    const map = (items: MultiDeviceSessionView[]) => items
      .filter((projection) => projection.key !== removeKey)
      .map(patch);
    this.state = {
      ...this.state,
      projects: this.state.projects.map((project) => ({
        ...project,
        workspaces: project.workspaces.map((workspace) => ({
          ...workspace,
          sessions: map(workspace.sessions)
        }))
      })),
      unassigned: map(this.state.unassigned),
      archivedSessions: map(this.state.archivedSessions)
    };
  }

  private enqueueSessionUpdate(
    key: string,
    projection: MultiDeviceSessionView,
    patch: SessionUpdate
  ): Promise<void> {
    const queue = this.sessionUpdateQueues.get(key) ?? {
      base: $state.snapshot(projection.session),
      entries: [],
      running: false
    };
    this.sessionUpdateQueues.set(key, queue);
    const pendingToken = this.beginPending(key, 'updating');
    const promise = new Promise<void>((resolve, reject) => {
      queue.entries.push({
        ref: $state.snapshot(projection.ref),
        patch: structuredClone(patch),
        pendingToken,
        resolve,
        reject
      });
    });
    this.recomputeQueuedSession(key, queue);
    if (!queue.running) void this.drainSessionUpdates(key, queue);
    return promise;
  }

  private async drainSessionUpdates(key: string, queue: SessionUpdateQueue): Promise<void> {
    queue.running = true;
    while (queue.entries.length > 0) {
      const entry = queue.entries[0]!;
      try {
        const updated = await ipc.sessions.updateOnDevice(entry.ref, structuredClone(entry.patch));
        queue.base = structuredClone(updated.session);
        this.replaceProjection(updated);
        queue.entries.shift();
        this.recomputeQueuedSession(key, queue);
        entry.resolve();
      } catch (error) {
        queue.entries.shift();
        this.recomputeQueuedSession(key, queue);
        entry.reject(error);
      } finally {
        this.endPending(key, entry.pendingToken);
      }
    }
    queue.running = false;
    if (this.sessionUpdateQueues.get(key) === queue) this.sessionUpdateQueues.delete(key);
  }

  private recomputeQueuedSession(key: string, queue: SessionUpdateQueue): void {
    const optimistic = queue.entries.reduce(
      (session, entry) => ({ ...session, ...structuredClone(entry.patch) }),
      structuredClone(queue.base)
    );
    this.patchProjection(key, (projection) => ({ ...projection, session: optimistic }));
  }

  private reapplyPendingSessionUpdates(): void {
    for (const [key, queue] of this.sessionUpdateQueues) {
      const authoritative = this.sessions.find((projection) => projection.key === key)?.session;
      if (
        authoritative
        && (authoritative.version ?? -1) > (queue.base.version ?? -1)
      ) {
        queue.base = $state.snapshot(authoritative);
      }
      this.recomputeQueuedSession(key, queue);
    }
  }

  private beginPending(key: string, operation: DeviceSessionPendingOperation): number {
    const token = ++this.pendingSequence;
    const pending = this.pendingBySession.get(key) ?? new Map<number, DeviceSessionPendingOperation>();
    pending.set(token, operation);
    this.pendingBySession.set(key, pending);
    this.pendingOperations = { ...this.pendingOperations, [key]: operation };
    return token;
  }

  private isLatestPending(key: string, token: number): boolean {
    const pending = this.pendingBySession.get(key);
    return pending ? [...pending.keys()].at(-1) === token : false;
  }

  private endPending(key: string, token: number): void {
    const pending = this.pendingBySession.get(key);
    pending?.delete(token);
    if (!pending?.size) {
      this.pendingBySession.delete(key);
      const next = { ...this.pendingOperations };
      delete next[key];
      this.pendingOperations = next;
      return;
    }
    this.pendingOperations = {
      ...this.pendingOperations,
      [key]: [...pending.values()].at(-1)!
    };
  }

  private async refreshAfterCurrent(): Promise<void> {
    const active = this.refreshRequest;
    if (active) await active.catch(() => undefined);
    await this.refresh();
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

function stateWithOptimisticSessionOrder(
  state: MultiDeviceSessionState,
  orderedKeys: readonly string[]
): MultiDeviceSessionState {
  const rank = new Map(orderedKeys.map((key, index) => [key, index] as const));
  const reorder = (sessions: MultiDeviceSessionView[]): MultiDeviceSessionView[] => {
    const ordered = sessions
      .filter((session) => rank.has(session.key))
      .sort((left, right) => rank.get(left.key)! - rank.get(right.key)!);
    let index = 0;
    return sessions.map((session) => rank.has(session.key) ? ordered[index++]! : session);
  };
  const snapshot = structuredClone(state);
  snapshot.projects = snapshot.projects.map((project) => ({
    ...project,
    workspaces: project.workspaces.map((workspace) => ({
      ...workspace,
      sessions: reorder(workspace.sessions)
    }))
  }));
  snapshot.unassigned = reorder(snapshot.unassigned);
  return snapshot;
}

function terminalRefKey(ref: TerminalRef): string {
  return `${ref.deviceId}/${encodeURIComponent(ref.terminalId)}`;
}

function isRecoverableTerminalControlError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'terminal_control_lease_stale'
    || code === 'terminal_input_lease_required';
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

function observedAgentSnapshot(value: unknown): ObservedAgentSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as { id?: unknown; subjectKind?: unknown; state?: unknown };
  if (typeof snapshot.id !== 'string' || !snapshot.id) return null;
  if (typeof snapshot.subjectKind !== 'string' || typeof snapshot.state !== 'string') return null;
  return value as ObservedAgentSnapshot;
}

export const deviceSessions = new DeviceSessionsStore();
