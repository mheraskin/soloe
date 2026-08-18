import type {
  SessionDeviceSnapshot,
  DeviceTerminalReplay,
  DeviceTerminalScreenSnapshot
} from '@shared/types/multi-device-sessions.js';
import type {
  DeviceDescriptor,
  DeviceEventEnvelope,
  DeviceId,
  DevicePortForwardResult
} from '@shared/types/devices.js';
import type {
  TerminalExitEvent,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStatusEvent,
  TerminalInputLeaseEvent
} from '@shared/types/terminal.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import { TailscalePortForwardManager, type WorkspaceDeviceStore } from '@soloe/domain';
import type { ProjectStore } from '../projects/ProjectStore.js';
import type { Project, ProjectOpenRequest } from '@shared/types/projects.js';
import type { GitService } from '../git/GitService.js';
import type { WorkspaceDeviceService } from '@soloe/domain';
import type { GitHubProviderService } from '@soloe/domain';
import type {
  DevicePlacedSessionRequest,
  DeviceSessionSourceUpdateRequest,
  DeviceWorkspaceIntent,
  WorkspaceDirectoryListing,
  DeviceWorkspacePlan
} from '@shared/types/workspaces.js';
import type { DeviceCommandEnvelope, DeviceOperationReceipt } from '@shared/types/commands.js';
import type { Session, SessionId } from '@shared/types/sessions.js';
import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type { ImagePasteRequest, ImagePasteResult } from '@shared/types/files.js';
import {
  terminalControlProof,
  type TerminalControlProof,
  type TerminalInputLease,
  type TerminalStartResult
} from '@shared/types/terminal.js';
import type {
  CreateGitHubRepositoryIntent,
  GitHubOwner,
  GitHubProviderStatus,
  GitHubRepositoryOperationReceipt,
  GitHubRepositoryPlan
} from '@shared/types/providers.js';
import type { PtyManager } from '../terminal/PtyManager.js';
import type { RuntimeTerminalInputControl } from '../terminal/RemoteRuntimePtyProcessFactory.js';
import { TerminalInputLeaseManager } from '@soloe/runtime';
import type { FileService } from '@soloe/domain';
import { randomUUID } from 'node:crypto';
import type {
  DeviceSessionInventory,
  SessionDevice,
  SessionDeviceStatus
} from '../sessions/MultiDeviceSessions.js';

export interface LocalSessionDeviceOptions {
  descriptor: DeviceDescriptor;
  sessions: SessionStore;
  projects?: Pick<ProjectStore, 'list' | 'open'>;
  git?: Pick<GitService, 'listWorktrees' | 'getRemoteUrl'>;
  workspaceDevice?: Pick<WorkspaceDeviceStore, 'snapshot' | 'reconcileLegacy'>;
  workspaceService?: Pick<
    WorkspaceDeviceService,
    'plan' | 'execute' | 'getCommand' | 'browseDirectories'
  >;
  githubProvider?: Pick<GitHubProviderService, 'status' | 'listOwners' | 'plan' | 'execute' | 'getCommand'>;
  pty: PtyManager;
  observer?: { listSnapshots(): ObservedAgentSnapshot[] };
  terminalInputControl?: RuntimeTerminalInputControl;
  files?: Pick<FileService, 'pasteImagesIntoTerminal'>;
  clientId?: string;
  tailscalePorts?: Pick<TailscalePortForwardManager, 'ensure'>;
}

export class LocalSessionDevice implements SessionDevice {
  readonly deviceId: DeviceId;
  readonly local = true;
  private currentStatus: SessionDeviceStatus;
  private readonly eventListeners = new Set<(event: DeviceEventEnvelope) => void>();
  private readonly statusListeners = new Set<(status: SessionDeviceStatus) => void>();
  private readonly demandedTerminals = new Set<string>();
  private sequence = 0;
  private connected = false;
  private disposed = false;
  private readonly ptyDetachers: Array<() => void> = [];
  private readonly clientId: string;
  private readonly inputLeases: TerminalInputLeaseManager;
  private readonly ownedInputLeases = new Map<string, TerminalInputLease>();
  private inputControlDetach: (() => void) | null = null;
  private readonly tailscalePorts: Pick<TailscalePortForwardManager, 'ensure'>;

  constructor(private readonly options: LocalSessionDeviceOptions) {
    this.deviceId = options.descriptor.deviceId;
    this.clientId = options.clientId ?? `sessions-${randomUUID()}`;
    this.tailscalePorts = options.tailscalePorts ?? new TailscalePortForwardManager();
    this.inputLeases = new TerminalInputLeaseManager({
      onChange: (event) => this.publishEvent('inputLease', event)
    });
    if (options.terminalInputControl) {
      this.inputControlDetach = options.terminalInputControl.onInputLease((event) => {
        this.observeInputLease(event);
        this.publishEvent('inputLease', event);
      });
    }
    this.currentStatus = {
      deviceId: this.deviceId,
      state: 'idle',
      descriptor: structuredClone(options.descriptor)
    };
  }

  get status(): SessionDeviceStatus {
    return structuredClone(this.currentStatus);
  }

  async connect(): Promise<SessionDeviceStatus> {
    this.assertActive();
    if (!this.connected) this.attachPtyEvents();
    this.connected = true;
    this.currentStatus = {
      deviceId: this.deviceId,
      state: 'ready',
      descriptor: structuredClone(this.options.descriptor)
    };
    this.publishStatus();
    return this.status;
  }

  async snapshot(): Promise<SessionDeviceSnapshot> {
    this.assertActive();
    if (!this.connected) await this.connect();
    let [sessions, archivedSessions] = await Promise.all([
      this.options.sessions.list(),
      this.options.sessions.listArchived()
    ]);
    if (this.options.projects && this.options.workspaceDevice) {
      const projects = await this.options.projects.list();
      const reconciled = await this.options.workspaceDevice.reconcileLegacy({
        projects,
        sessions: [...sessions, ...archivedSessions]
      });
      for (const binding of reconciled.sessionSources) {
        const session = await this.options.sessions.get(binding.sessionId);
        if (!session || session.source) continue;
        await this.options.sessions.bindSource(
          session.id,
          binding.source,
          session.version ?? 1
        );
      }
      [sessions, archivedSessions] = await Promise.all([
        this.options.sessions.list(),
        this.options.sessions.listArchived()
      ]);
    }
    return {
      descriptor: structuredClone(this.options.descriptor),
      workspace: this.options.workspaceDevice?.snapshot() ?? null,
      sessions,
      archivedSessions,
      runtimes: this.options.pty.listRunning(),
      observations: this.options.observer?.listSnapshots() ?? [],
      capturedAt: new Date().toISOString()
    };
  }

  async readInventory(): Promise<DeviceSessionInventory> {
    const state = await this.snapshot();
    const projects = await this.options.projects?.list() ?? [];
    const projectInventories = await Promise.all(projects.map(async (project) => {
      const runMode = project.defaultRunMode ?? this.options.descriptor.platform;
      const worktrees = this.options.git
        ? await this.options.git.listWorktrees(project.path, false, {
            runMode,
            ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
          })
        : [];
      const canonicalUrl = this.options.git
        ? await this.options.git.getRemoteUrl(project.path, 'origin', {
            runMode,
            ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
          }).catch(() => null)
        : null;
      const repositoryRecord = state.workspace?.repositories.find((candidate) =>
        candidate.legacyProjectId === project.id
      ) ?? (() => {
        const checkout = state.workspace?.checkouts.find((candidate) =>
          sameDevicePath(candidate.path, project.path)
        );
        return checkout
          ? state.workspace?.repositories.find((candidate) => candidate.id === checkout.repositoryId)
          : undefined;
      })();
      return {
        project: structuredClone(project),
        repository: structuredClone(
          canonicalUrl ? { kind: 'git' as const, canonicalUrl } : repositoryRecord?.identity ?? null
        ),
        repositoryId: repositoryRecord?.id ?? null,
        worktrees: structuredClone(worktrees)
      };
    }));
    return {
      descriptor: state.descriptor,
      projects: projectInventories,
      sessions: state.sessions,
      archivedSessions: state.archivedSessions,
      runtimes: state.runtimes,
      observations: state.observations ?? [],
      capturedAt: state.capturedAt
    };
  }

  reorderSessions(orderedIds: SessionId[]): Promise<Session[]> {
    this.assertActive();
    return this.options.sessions.reorder([...orderedIds]);
  }

  async setTerminalOutputDemand(terminalIds: ReadonlySet<string>): Promise<void> {
    this.assertActive();
    this.demandedTerminals.clear();
    for (const terminalId of terminalIds) {
      if (terminalId.trim()) this.demandedTerminals.add(terminalId);
    }
  }

  async terminalInput(terminalId: string, data: string, control: TerminalControlProof): Promise<void> {
    this.assertActive();
    const id = requiredId(terminalId);
    if (this.options.terminalInputControl) {
      const lease = this.ownedInputLeases.get(id);
      if (!lease || !sameControlProof(control, terminalControlProof(lease))) {
        throw new Error('Session Control is stale.');
      }
      await this.options.terminalInputControl.writeInput(id, data, lease);
      return;
    }
    this.inputLeases.authorizeControl(id, control, 'input');
    this.options.pty.write(id, data);
  }

  pasteImagesIntoTerminal(request: ImagePasteRequest): Promise<ImagePasteResult> {
    this.assertActive();
    if (!this.options.files) {
      return Promise.reject(new Error('Image paste is unavailable on this Device.'));
    }
    return this.options.files.pasteImagesIntoTerminal(structuredClone(request));
  }

  terminalAcquireInputLease(
    terminalId: string,
    takeover = false,
    controller = { deviceId: this.deviceId, deviceName: this.status.descriptor?.name ?? this.deviceId }
  ): Promise<TerminalInputLease> {
    this.assertActive();
    if (this.options.terminalInputControl) {
      return this.options.terminalInputControl.acquireInputLease(
        requiredId(terminalId),
        takeover,
        { ...controller, ownerDeviceId: this.deviceId }
      )
        .then((lease) => {
          this.ownedInputLeases.set(lease.terminalId, lease);
          return lease;
        });
    }
    return Promise.resolve(this.inputLeases.acquire(requiredId(terminalId), this.clientId, {
      takeover,
      ownerDeviceId: this.deviceId,
      controllerDeviceId: controller.deviceId,
      controllerDeviceName: controller.deviceName
    }));
  }

  terminalCurrentInputLease(terminalId: string): Promise<TerminalInputLease | null> {
    this.assertActive();
    const id = requiredId(terminalId);
    if (this.options.terminalInputControl) {
      return this.options.terminalInputControl.currentInputLease(id);
    }
    return Promise.resolve(this.inputLeases.current(id));
  }

  terminalReleaseInputLease(terminalId: string, control: TerminalControlProof): Promise<boolean> {
    this.assertActive();
    const id = requiredId(terminalId);
    if (this.options.terminalInputControl) {
      return this.options.terminalInputControl.releaseInputLease(id, control)
        .then((released) => {
          if (released) this.ownedInputLeases.delete(id);
          return released;
        });
    }
    return Promise.resolve(this.inputLeases.release(id, control));
  }

  terminalParkInputLease(terminalId: string, control: TerminalControlProof): Promise<boolean> {
    this.assertActive();
    const id = requiredId(terminalId);
    if (this.options.terminalInputControl) {
      return this.options.terminalInputControl.parkInputLease(id, control)
        .then((parked) => {
          if (parked) this.ownedInputLeases.delete(id);
          return parked;
        });
    }
    return Promise.resolve(this.inputLeases.park(id, control));
  }

  async terminalResize(
    terminalId: string,
    cols: number,
    rows: number,
    control: TerminalControlProof
  ): Promise<void> {
    this.assertActive();
    const id = requiredId(terminalId);
    if (this.options.terminalInputControl) {
      const lease = this.ownedInputLeases.get(id);
      if (!lease || !sameControlProof(control, terminalControlProof(lease))) {
        throw new Error('Session Control is stale.');
      }
      await this.options.terminalInputControl.resizeTerminal(id, cols, rows, lease);
      return;
    }
    this.inputLeases.resize(id, control, cols, rows);
    this.options.pty.resize(id, { cols, rows });
  }

  async terminalReplay(terminalId: string, afterSeq = 0): Promise<DeviceTerminalReplay> {
    this.assertActive();
    const id = requiredId(terminalId);
    const snapshot = await this.options.pty.replay(id, afterSeq);
    return {
      terminalRef: { deviceId: this.deviceId, terminalId: id },
      sessionRef: snapshot
        ? { deviceId: this.deviceId, sessionId: snapshot.sessionId }
        : null,
      snapshot
    };
  }

  async terminalScreenSnapshot(terminalId: string): Promise<DeviceTerminalScreenSnapshot> {
    this.assertActive();
    const id = requiredId(terminalId);
    const snapshot = await this.options.pty.screenSnapshot(id);
    return {
      terminalRef: { deviceId: this.deviceId, terminalId: id },
      sessionRef: snapshot
        ? { deviceId: this.deviceId, sessionId: snapshot.sessionId }
        : null,
      snapshot
    };
  }

  async terminalStop(terminalId: string): Promise<void> {
    this.assertActive();
    const id = requiredId(terminalId);
    await this.options.pty.stop(id);
    this.inputLeases.clearTerminal(id);
  }

  async ensureTailscalePort(port: number): Promise<DevicePortForwardResult> {
    this.assertActive();
    const status = await this.tailscalePorts.ensure(port);
    return { deviceId: this.deviceId, ...status };
  }

  workspacePlan(intent: DeviceWorkspaceIntent): Promise<DeviceWorkspacePlan> {
    this.assertActive();
    if (!this.options.workspaceService) throw new Error('Local Workspace placement is unavailable.');
    return this.options.workspaceService.plan(structuredClone(intent));
  }

  workspaceExecute(
    command: DeviceCommandEnvelope<DeviceWorkspaceIntent>
  ): Promise<DeviceOperationReceipt> {
    this.assertActive();
    if (!this.options.workspaceService) throw new Error('Local Workspace placement is unavailable.');
    return this.options.workspaceService.execute(structuredClone(command));
  }

  browseWorkspaceDirectories(path?: string): Promise<WorkspaceDirectoryListing> {
    this.assertActive();
    if (!this.options.workspaceService) throw new Error('Local Workspace placement is unavailable.');
    return this.options.workspaceService.browseDirectories(path);
  }

  workspaceGetCommand(
    clientId: string,
    commandId: string
  ): Promise<DeviceOperationReceipt | null> {
    this.assertActive();
    if (!this.options.workspaceService) throw new Error('Local Workspace placement is unavailable.');
    return Promise.resolve(this.options.workspaceService.getCommand(clientId, commandId));
  }

  createSession(request: DevicePlacedSessionRequest): Promise<Session> {
    this.assertActive();
    return this.options.sessions.createWithId(
      request.sessionId,
      structuredClone(request.draft)
    );
  }

  startSession(sessionId: string): Promise<TerminalStartResult> {
    this.assertActive();
    return this.options.pty.start({ sessionId: requiredId(sessionId) });
  }

  openProject(request: ProjectOpenRequest): Promise<Project> {
    this.assertActive();
    if (!this.options.projects) throw new Error('Local Project registration is unavailable.');
    return this.options.projects.open(structuredClone(request));
  }

  rebindSessionSource(request: DeviceSessionSourceUpdateRequest): Promise<Session> {
    this.assertActive();
    return this.options.sessions.bindSource(
      request.sessionId,
      structuredClone(request.source),
      request.expectedVersion
    );
  }

  githubProviderStatus(): Promise<GitHubProviderStatus> {
    this.assertActive();
    if (!this.options.githubProvider) throw new Error('GitHub provider is unavailable.');
    return this.options.githubProvider.status();
  }

  githubProviderOwners(): Promise<GitHubOwner[]> {
    this.assertActive();
    if (!this.options.githubProvider) throw new Error('GitHub provider is unavailable.');
    return this.options.githubProvider.listOwners();
  }

  githubProviderPlan(intent: CreateGitHubRepositoryIntent): Promise<GitHubRepositoryPlan> {
    this.assertActive();
    if (!this.options.githubProvider) throw new Error('GitHub provider is unavailable.');
    return this.options.githubProvider.plan(structuredClone(intent));
  }

  githubProviderExecute(
    command: DeviceCommandEnvelope<CreateGitHubRepositoryIntent>
  ): Promise<GitHubRepositoryOperationReceipt> {
    this.assertActive();
    if (!this.options.githubProvider) throw new Error('GitHub provider is unavailable.');
    return this.options.githubProvider.execute(structuredClone(command));
  }

  githubProviderGetCommand(
    clientId: string,
    commandId: string
  ): Promise<DeviceOperationReceipt | null> {
    this.assertActive();
    if (!this.options.githubProvider) throw new Error('GitHub provider is unavailable.');
    return Promise.resolve(this.options.githubProvider.getCommand(clientId, commandId));
  }

  onEvent(listener: (event: DeviceEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: SessionDeviceStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inputControlDetach?.();
    this.inputControlDetach = null;
    this.ownedInputLeases.clear();
    this.inputLeases.releaseTransportClient(this.clientId);
    for (const detach of this.ptyDetachers.splice(0)) detach();
    this.currentStatus = {
      deviceId: this.deviceId,
      state: 'disposed',
      descriptor: structuredClone(this.options.descriptor)
    };
    this.publishStatus();
    this.eventListeners.clear();
    this.statusListeners.clear();
  }

  private attachPtyEvents(): void {
    const onOutput = (payload: TerminalOutputEvent) => {
      if (this.demandedTerminals.has(payload.terminalId)) this.publishEvent('output', payload);
    };
    const onExit = (payload: TerminalExitEvent) => {
      this.inputLeases.clearTerminal(payload.terminalId);
      this.publishEvent('exit', payload);
    };
    const onLocation = (payload: TerminalLocationEvent) => this.publishEvent('location', payload);
    const onStatus = (payload: TerminalStatusEvent) => this.publishEvent('status', payload);
    this.options.pty.on('output', onOutput);
    this.options.pty.on('exit', onExit);
    this.options.pty.on('location', onLocation);
    this.options.pty.on('status', onStatus);
    this.ptyDetachers.push(
      () => this.options.pty.off('output', onOutput),
      () => this.options.pty.off('exit', onExit),
      () => this.options.pty.off('location', onLocation),
      () => this.options.pty.off('status', onStatus)
    );
  }

  private publishEvent(event: string, payload: unknown): void {
    this.sequence += 1;
    const envelope: DeviceEventEnvelope = {
      event,
      deviceId: this.deviceId,
      serverEpoch: this.options.descriptor.serverEpoch,
      sequence: this.sequence,
      observedAt: new Date().toISOString(),
      payload
    };
    for (const listener of this.eventListeners) listener(envelope);
  }

  private publishStatus(): void {
    const status = this.status;
    for (const listener of this.statusListeners) listener(status);
  }

  private observeInputLease(event: TerminalInputLeaseEvent): void {
    const owned = this.ownedInputLeases.get(event.terminalId);
    if (!owned) return;
    if (!event.lease || event.lease.leaseId !== owned.leaseId) {
      this.ownedInputLeases.delete(event.terminalId);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Local Device client is disposed.');
  }
}

function sameControlProof(left: TerminalControlProof, right: TerminalControlProof): boolean {
  return left.sessionId === right.sessionId
    && left.ownerDeviceId === right.ownerDeviceId
    && left.controllerDeviceId === right.controllerDeviceId
    && left.leaseId === right.leaseId;
}

function requiredId(value: string): string {
  const id = value.trim();
  if (!id) throw new Error('Terminal ID is required.');
  return id;
}

function sameDevicePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase();
  return normalize(left) === normalize(right);
}
