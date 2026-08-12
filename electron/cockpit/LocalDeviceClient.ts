import type {
  CockpitTerminalReplay,
  DeviceReadSnapshot
} from '@shared/types/cockpit.js';
import type {
  DeviceDescriptor,
  DeviceEventEnvelope,
  DeviceId
} from '@shared/types/devices.js';
import type {
  TerminalExitEvent,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { WorkspaceDeviceStore } from '@soloe/domain';
import type { ProjectStore } from '../projects/ProjectStore.js';
import type { WorkspaceDeviceService } from '@soloe/domain';
import type { GitHubProviderService } from '@soloe/domain';
import type {
  DevicePlacedSessionRequest,
  DeviceSessionSourceUpdateRequest,
  DeviceWorkspaceIntent,
  DeviceWorkspacePlan
} from '@shared/types/workspaces.js';
import type { DeviceCommandEnvelope, DeviceOperationReceipt } from '@shared/types/commands.js';
import type { Session } from '@shared/types/sessions.js';
import type { TerminalInputLease, TerminalStartResult } from '@shared/types/terminal.js';
import type {
  CreateGitHubRepositoryIntent,
  GitHubOwner,
  GitHubProviderStatus,
  GitHubRepositoryOperationReceipt,
  GitHubRepositoryPlan
} from '@shared/types/providers.js';
import type { PtyManager } from '../terminal/PtyManager.js';
import type { DevicePort, DevicePortStatus } from './DevicePort.js';
import { TerminalInputLeaseManager } from '@soloe/runtime';
import { randomUUID } from 'node:crypto';

export interface LocalDeviceClientOptions {
  descriptor: DeviceDescriptor;
  sessions: SessionStore;
  projects?: Pick<ProjectStore, 'list'>;
  workspaceDevice?: Pick<WorkspaceDeviceStore, 'snapshot' | 'reconcileLegacy'>;
  workspaceService?: Pick<WorkspaceDeviceService, 'plan' | 'execute' | 'getCommand'>;
  githubProvider?: Pick<GitHubProviderService, 'status' | 'listOwners' | 'plan' | 'execute' | 'getCommand'>;
  pty: PtyManager;
  clientId?: string;
}

export class LocalDeviceClient implements DevicePort {
  readonly deviceId: DeviceId;
  private currentStatus: DevicePortStatus;
  private readonly eventListeners = new Set<(event: DeviceEventEnvelope) => void>();
  private readonly statusListeners = new Set<(status: DevicePortStatus) => void>();
  private readonly demandedTerminals = new Set<string>();
  private sequence = 0;
  private connected = false;
  private disposed = false;
  private readonly ptyDetachers: Array<() => void> = [];
  private readonly clientId: string;
  private readonly inputLeases: TerminalInputLeaseManager;

  constructor(private readonly options: LocalDeviceClientOptions) {
    this.deviceId = options.descriptor.deviceId;
    this.clientId = options.clientId ?? `cockpit-${randomUUID()}`;
    this.inputLeases = new TerminalInputLeaseManager({
      onChange: (event) => this.publishEvent('inputLease', event)
    });
    this.currentStatus = {
      deviceId: this.deviceId,
      state: 'idle',
      descriptor: structuredClone(options.descriptor)
    };
  }

  get status(): DevicePortStatus {
    return structuredClone(this.currentStatus);
  }

  async connect(): Promise<DevicePortStatus> {
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

  async snapshot(): Promise<DeviceReadSnapshot> {
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
      capturedAt: new Date().toISOString()
    };
  }

  async setTerminalOutputDemand(terminalIds: ReadonlySet<string>): Promise<void> {
    this.assertActive();
    this.demandedTerminals.clear();
    for (const terminalId of terminalIds) {
      if (terminalId.trim()) this.demandedTerminals.add(terminalId);
    }
  }

  async terminalInput(terminalId: string, data: string): Promise<void> {
    this.assertActive();
    const id = requiredId(terminalId);
    const lease = this.inputLeases.acquire(id, this.clientId);
    this.inputLeases.authorizeInput(id, this.clientId, lease.leaseId);
    this.options.pty.write(id, data);
  }

  terminalAcquireInputLease(
    terminalId: string,
    takeover = false
  ): Promise<TerminalInputLease> {
    this.assertActive();
    return Promise.resolve(this.inputLeases.acquire(requiredId(terminalId), this.clientId, {
      takeover
    }));
  }

  async terminalResize(terminalId: string, cols: number, rows: number): Promise<void> {
    this.assertActive();
    this.options.pty.resize(requiredId(terminalId), { cols, rows });
  }

  async terminalReplay(terminalId: string, afterSeq = 0): Promise<CockpitTerminalReplay> {
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

  async terminalStop(terminalId: string): Promise<void> {
    this.assertActive();
    const id = requiredId(terminalId);
    await this.options.pty.stop(id);
    this.inputLeases.clearTerminal(id);
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

  workspaceGetCommand(
    cockpitId: string,
    commandId: string
  ): Promise<DeviceOperationReceipt | null> {
    this.assertActive();
    if (!this.options.workspaceService) throw new Error('Local Workspace placement is unavailable.');
    return Promise.resolve(this.options.workspaceService.getCommand(cockpitId, commandId));
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
    cockpitId: string,
    commandId: string
  ): Promise<DeviceOperationReceipt | null> {
    this.assertActive();
    if (!this.options.githubProvider) throw new Error('GitHub provider is unavailable.');
    return Promise.resolve(this.options.githubProvider.getCommand(cockpitId, commandId));
  }

  onEvent(listener: (event: DeviceEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: DevicePortStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inputLeases.releaseOwner(this.clientId);
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

  private assertActive(): void {
    if (this.disposed) throw new Error('Local Device client is disposed.');
  }
}

function requiredId(value: string): string {
  const id = value.trim();
  if (!id) throw new Error('Terminal ID is required.');
  return id;
}
