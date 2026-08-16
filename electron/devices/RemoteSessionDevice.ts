import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

import type {
  SessionDeviceSnapshot,
  DeviceTerminalReplay
} from '@shared/types/multi-device-sessions.js';
import type {
  DeviceDescriptor,
  DeviceEventEnvelope,
  DeviceId
} from '@shared/types/devices.js';
import type { Session, SessionId, SessionRuntimeState } from '@shared/types/sessions.js';
import type { Project, ProjectOpenRequest } from '@shared/types/projects.js';
import type { GitWorktree } from '@shared/types/git.js';
import type {
  TerminalControlProof,
  TerminalInputLease,
  TerminalReplaySnapshot,
  TerminalStartResult
} from '@shared/types/terminal.js';
import type {
  DevicePlacedSessionRequest,
  DeviceSessionSourceUpdateRequest,
  DeviceWorkspaceSnapshot
} from '@shared/types/workspaces.js';
import type {
  DeviceWorkspaceIntent,
  DeviceWorkspacePlan,
  WorkspaceDirectoryListing
} from '@shared/types/workspaces.js';
import type { DeviceCommandEnvelope, DeviceOperationReceipt } from '@shared/types/commands.js';
import type {
  CreateGitHubRepositoryIntent,
  GitHubOwner,
  GitHubProviderStatus,
  GitHubRepositoryOperationReceipt,
  GitHubRepositoryPlan
} from '@shared/types/providers.js';
import {
  DeviceTransport,
  type DeviceTransportStatus
} from '../connections/DeviceTransport.js';
import type { FetchLike } from '../connections/SoloeEndpointProbe.js';
import type {
  DeviceSessionInventory,
  SessionDevice,
  SessionDeviceStatus
} from '../sessions/MultiDeviceSessions.js';

const MAX_RPC_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface RemoteSessionDeviceOptions {
  deviceId: DeviceId;
  endpoint: string;
  fetchImpl: FetchLike;
  socketFactory?: ConstructorParameters<typeof DeviceTransport>[0]['socketFactory'];
  token?: string;
  bootstrapTailscale?: boolean;
  clientId?: string;
  reconnectDelay?: (attempt: number) => number;
  local?: boolean;
}

export class RemoteSessionDevice implements SessionDevice {
  readonly deviceId: DeviceId;
  readonly local: boolean;
  private readonly clientId: string;
  private readonly transport: DeviceTransport;
  private readonly eventListeners = new Set<(event: DeviceEventEnvelope) => void>();
  private readonly statusListeners = new Set<(status: SessionDeviceStatus) => void>();
  private demandedTerminals = new Set<string>();
  private currentStatus: SessionDeviceStatus;
  private detachTransportEvent: () => void;
  private detachTransportStatus: () => void;
  private detachTransportRepair: () => void;
  private connectRequest: Promise<SessionDeviceStatus> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disposed = false;

  constructor(private readonly options: RemoteSessionDeviceOptions) {
    this.deviceId = options.deviceId;
    this.local = options.local ?? false;
    this.clientId = options.clientId ?? `sessions-${randomUUID()}`;
    this.currentStatus = {
      deviceId: this.deviceId,
      state: 'idle',
      descriptor: null
    };
    this.transport = new DeviceTransport({
      endpoint: options.endpoint,
      fetchImpl: options.fetchImpl,
      socketFactory: options.socketFactory ?? createNodeSocket,
      ...(options.token ? { token: options.token } : {}),
      ...(options.bootstrapTailscale ? { bootstrapTailscale: true } : {}),
      clientId: this.clientId,
      expectedDeviceId: this.deviceId
    });
    this.detachTransportEvent = this.transport.onEvent(({ envelope }) => {
      for (const listener of this.eventListeners) listener(envelope);
    });
    this.detachTransportStatus = this.transport.onStatus((status) => {
      this.updateTransportStatus(status);
    });
    this.detachTransportRepair = this.transport.onRepairRequired((reason, detail) => {
      this.emitSyntheticRepair(reason, detail);
    });
  }

  get status(): SessionDeviceStatus {
    return cloneStatus(this.currentStatus);
  }

  async connect(): Promise<SessionDeviceStatus> {
    if (this.disposed) throw new Error(`Device ${this.deviceId} client is disposed.`);
    if (this.currentStatus.state === 'ready') return this.status;
    if (this.connectRequest) return this.connectRequest;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const request = this.connectNow().finally(() => {
      if (this.connectRequest === request) {
        this.connectRequest = null;
        if (this.currentStatus.state === 'offline') this.scheduleReconnect();
      }
    });
    this.connectRequest = request;
    return request;
  }

  private async connectNow(): Promise<SessionDeviceStatus> {
    try {
      await this.transport.connect();
      if (this.transport.status.compatibility?.status !== 'compatible') {
        this.currentStatus = {
          deviceId: this.deviceId,
          state: 'incompatible',
          descriptor: this.transport.status.descriptor
        };
        this.publishStatus();
      }
      this.reconnectAttempt = 0;
      return this.status;
    } catch (error) {
      this.currentStatus = {
        deviceId: this.deviceId,
        state: 'offline',
        descriptor: this.transport.status.descriptor,
        error: error instanceof Error ? error.message : String(error)
      };
      this.publishStatus();
      this.scheduleReconnect();
      throw error;
    }
  }

  async snapshot(): Promise<SessionDeviceSnapshot> {
    if (!this.currentStatus.descriptor) await this.connect();
    const descriptor = this.currentStatus.descriptor;
    if (!descriptor) throw new Error(`Device ${this.deviceId} did not provide a descriptor.`);
    const [workspace, sessions, archivedSessions, runtimes] = await Promise.all([
      descriptor.capabilities.features.includes('workspace-device.v1')
        ? this.rpc<DeviceWorkspaceSnapshot>('workspaceDevice', 'snapshot', [])
        : Promise.resolve(null),
      this.rpc<Session[]>('sessions', 'list', []),
      this.rpc<Session[]>('sessions', 'listArchived', []),
      this.rpc<SessionRuntimeState[]>('terminal', 'listRunning', [])
    ]);
    return {
      descriptor: structuredClone(descriptor),
      workspace,
      sessions,
      archivedSessions,
      runtimes,
      capturedAt: new Date().toISOString()
    };
  }

  async readInventory(): Promise<DeviceSessionInventory> {
    if (!this.currentStatus.descriptor) await this.connect();
    const descriptor = this.currentStatus.descriptor;
    if (!descriptor) throw new Error(`Device ${this.deviceId} did not provide a descriptor.`);
    const [workspace, projects, sessions, archivedSessions, runtimes] = await Promise.all([
      descriptor.capabilities.features.includes('workspace-device.v1')
        ? this.rpc<DeviceWorkspaceSnapshot>('workspaceDevice', 'snapshot', [])
        : Promise.resolve(null),
      this.rpc<Project[]>('projects', 'list', []),
      this.rpc<Session[]>('sessions', 'list', []),
      this.rpc<Session[]>('sessions', 'listArchived', []),
      this.rpc<SessionRuntimeState[]>('terminal', 'listRunning', [])
    ]);
    const projectInventories = await Promise.all(projects.map(async (project) => {
      const runMode = project.defaultRunMode ?? descriptor.platform;
      const gitRequest = {
        repoPath: project.path,
        force: false,
        runMode,
        ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
      };
      const [worktrees, remoteUrl] = await Promise.all([
        this.rpc<GitWorktree[]>('git', 'worktrees', [gitRequest]),
        this.rpc<unknown>('git', 'remoteUrl', [gitRequest]).catch(() => null)
      ]);
      const canonicalUrl = validRemoteUrl(remoteUrl);
      const repositoryRecord = workspace?.repositories.find((candidate) =>
        candidate.legacyProjectId === project.id
      ) ?? (() => {
        const checkout = workspace?.checkouts.find((candidate) =>
          sameDevicePath(candidate.path, project.path)
        );
        return checkout
          ? workspace?.repositories.find((candidate) => candidate.id === checkout.repositoryId)
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
      descriptor: structuredClone(descriptor),
      projects: projectInventories,
      sessions,
      archivedSessions,
      runtimes,
      capturedAt: new Date().toISOString()
    };
  }

  reorderSessions(orderedIds: SessionId[]): Promise<Session[]> {
    return this.rpc('sessions', 'reorder', [[...orderedIds]]);
  }

  async setTerminalOutputDemand(terminalIds: ReadonlySet<string>): Promise<void> {
    const desired = new Set(terminalIds);
    const removals = [...this.demandedTerminals].filter((id) => !desired.has(id));
    const additions = [...desired].filter((id) => !this.demandedTerminals.has(id));
    for (const terminalId of removals) {
      await this.rpc('terminal', 'setOutputDemand', [{ terminalId, active: false }]);
    }
    for (const terminalId of additions) {
      await this.rpc('terminal', 'setOutputDemand', [{ terminalId, active: true }]);
    }
    this.demandedTerminals = desired;
  }

  async terminalInput(terminalId: string, data: string, control: TerminalControlProof): Promise<void> {
    await this.rpc('terminal', 'input', [
      requiredId(terminalId, 'Terminal'),
      data,
      structuredClone(control)
    ]);
  }

  terminalAcquireInputLease(
    terminalId: string,
    takeover = false,
    controller = { deviceId: this.deviceId, deviceName: this.deviceId }
  ): Promise<TerminalInputLease> {
    return this.rpc('terminal', 'acquireInputLease', [
      requiredId(terminalId, 'Terminal'),
      takeover,
      controller
    ]);
  }

  terminalCurrentInputLease(terminalId: string): Promise<TerminalInputLease | null> {
    return this.rpc('terminal', 'currentInputLease', [
      requiredId(terminalId, 'Terminal')
    ]);
  }

  terminalReleaseInputLease(terminalId: string, control: TerminalControlProof): Promise<boolean> {
    return this.rpc('terminal', 'releaseInputLease', [
      requiredId(terminalId, 'Terminal'),
      structuredClone(control)
    ]);
  }

  async terminalResize(
    terminalId: string,
    cols: number,
    rows: number,
    control: TerminalControlProof
  ): Promise<void> {
    await this.rpc('terminal', 'resize', [
      requiredId(terminalId, 'Terminal'),
      positiveInteger(cols, 'columns'),
      positiveInteger(rows, 'rows'),
      structuredClone(control)
    ]);
  }

  async terminalReplay(
    terminalId: string,
    afterSeq = 0
  ): Promise<DeviceTerminalReplay> {
    const id = requiredId(terminalId, 'Terminal');
    const snapshot = await this.rpc<TerminalReplaySnapshot | null>(
      'terminal',
      'replay',
      [id, nonNegativeInteger(afterSeq, 'replay sequence')]
    );
    return {
      terminalRef: { deviceId: this.deviceId, terminalId: id },
      sessionRef: snapshot
        ? { deviceId: this.deviceId, sessionId: snapshot.sessionId }
        : null,
      snapshot
    };
  }

  async terminalStop(terminalId: string): Promise<void> {
    await this.rpc('terminal', 'stop', [requiredId(terminalId, 'Terminal')]);
  }

  workspacePlan(intent: DeviceWorkspaceIntent): Promise<DeviceWorkspacePlan> {
    return this.rpc('workspaceDevice', 'plan', [structuredClone(intent)]);
  }

  workspaceExecute(
    command: DeviceCommandEnvelope<DeviceWorkspaceIntent>
  ): Promise<DeviceOperationReceipt> {
    return this.rpc('workspaceDevice', 'execute', [structuredClone(command)]);
  }

  browseWorkspaceDirectories(path?: string): Promise<WorkspaceDirectoryListing> {
    return this.rpc('workspaceDevice', 'browseDirectories', [{ ...(path ? { path } : {}) }]);
  }

  workspaceGetCommand(
    clientId: string,
    commandId: string
  ): Promise<DeviceOperationReceipt | null> {
    return this.rpc('workspaceDevice', 'getCommand', [clientId, commandId]);
  }

  createSession(request: DevicePlacedSessionRequest): Promise<Session> {
    return this.rpc('sessions', 'createPlaced', [structuredClone(request)]);
  }

  startSession(sessionId: string): Promise<TerminalStartResult> {
    const id = requiredId(sessionId, 'Session');
    return this.rpc('terminal', 'start', [{ sessionId: id }]);
  }

  openProject(request: ProjectOpenRequest): Promise<Project> {
    return this.rpc('projects', 'open', [structuredClone(request)]);
  }

  rebindSessionSource(request: DeviceSessionSourceUpdateRequest): Promise<Session> {
    return this.rpc('sessions', 'bindSource', [structuredClone(request)]);
  }

  githubProviderStatus(): Promise<GitHubProviderStatus> {
    return this.rpc('githubProvider', 'status', []);
  }

  githubProviderOwners(): Promise<GitHubOwner[]> {
    return this.rpc('githubProvider', 'listOwners', []);
  }

  githubProviderPlan(intent: CreateGitHubRepositoryIntent): Promise<GitHubRepositoryPlan> {
    return this.rpc('githubProvider', 'planCreateRepository', [structuredClone(intent)]);
  }

  githubProviderExecute(
    command: DeviceCommandEnvelope<CreateGitHubRepositoryIntent>
  ): Promise<GitHubRepositoryOperationReceipt> {
    return this.rpc('githubProvider', 'execute', [structuredClone(command)]);
  }

  githubProviderGetCommand(
    clientId: string,
    commandId: string
  ): Promise<DeviceOperationReceipt | null> {
    return this.rpc('githubProvider', 'getCommand', [clientId, commandId]);
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.detachTransportEvent();
    this.detachTransportStatus();
    this.detachTransportRepair();
    this.transport.dispose();
    this.eventListeners.clear();
    this.currentStatus = {
      deviceId: this.deviceId,
      state: 'disposed',
      descriptor: this.currentStatus.descriptor
    };
    this.publishStatus();
    this.statusListeners.clear();
  }

  private async rpc<T = true>(
    namespace: string,
    method: string,
    args: unknown[]
  ): Promise<T> {
    const response = await this.authenticatedFetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace, method, args, clientId: this.clientId })
    });
    if (!response.ok) throw new Error(`Device RPC returned HTTP ${response.status}.`);
    const text = await readBoundedResponse(response, MAX_RPC_RESPONSE_BYTES);
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error('Device RPC returned invalid JSON.');
    }
    if (!isRecord(result) || typeof result['ok'] !== 'boolean') {
      throw new Error('Device RPC returned a malformed result.');
    }
    if (result['ok'] === false) {
      const error = new Error(
        typeof result['error'] === 'string' ? result['error'] : 'Device RPC failed.'
      ) as Error & { code?: string; remediation?: string };
      if (typeof result['code'] === 'string') error.code = result['code'];
      if (typeof result['remediation'] === 'string') error.remediation = result['remediation'];
      throw error;
    }
    return result['value'] as T;
  }

  private async authenticatedFetch(pathname: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.options.token) headers.set('authorization', `Bearer ${this.options.token}`);
    const request = () => this.options.fetchImpl(new URL(pathname, this.options.endpoint), {
      ...init,
      headers,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error'
    });
    let response = await request();
    if (response.status !== 401 || !this.options.bootstrapTailscale) return response;
    const authenticated = await this.options.fetchImpl(
      new URL('/__soloe/auth/tailscale', this.options.endpoint),
      {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error'
      }
    );
    if (!authenticated.ok) return response;
    const cookie = authenticated.headers.get('set-cookie')?.split(';', 1)[0];
    if (cookie) headers.set('cookie', cookie);
    response = await request();
    return response;
  }

  private updateTransportStatus(status: DeviceTransportStatus): void {
    const state: SessionDeviceStatus['state'] = status.state === 'disposed'
      ? 'disposed'
      : status.state === 'connecting'
        ? 'connecting'
        : status.state === 'connected'
          ? status.compatibility?.status === 'compatible' ? 'ready' : 'incompatible'
          : status.state === 'idle'
            ? 'idle'
            : 'offline';
    this.currentStatus = {
      deviceId: this.deviceId,
      state,
      descriptor: status.descriptor
    };
    this.publishStatus();
    if (state === 'offline') this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.connectRequest) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const delay = this.options.reconnectDelay?.(attempt) ?? reconnectDelay(attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, Math.max(0, delay));
  }

  private emitSyntheticRepair(reason: string, detail: string): void {
    const descriptor = this.currentStatus.descriptor;
    if (!descriptor) return;
    const event: DeviceEventEnvelope = {
      event: 'transport.repair',
      deviceId: this.deviceId,
      serverEpoch: descriptor.serverEpoch,
      sequence: Math.max(1, this.transport.status.lastSequence ?? 1),
      observedAt: new Date().toISOString(),
      payload: { reason, detail }
    };
    for (const listener of this.eventListeners) listener(event);
  }

  private publishStatus(): void {
    const status = this.status;
    for (const listener of this.statusListeners) listener(status);
  }
}

function reconnectDelay(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function createNodeSocket(url: string): {
  addEventListener(event: string, listener: (event: Event) => void): void;
  close(code?: number, reason?: string): void;
} {
  const socket = new WebSocket(url);
  return {
    addEventListener(event, listener) {
      const addEventListener = socket.addEventListener.bind(socket) as unknown as (
        event: string,
        listener: (event: Event) => void
      ) => void;
      addEventListener(event, listener);
    },
    close(code, reason) {
      socket.close(code, reason);
    }
  };
}

function cloneStatus(status: SessionDeviceStatus): SessionDeviceStatus {
  return {
    ...status,
    descriptor: status.descriptor ? structuredClone(status.descriptor) : null
  };
}

function requiredId(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new Error(`${label} ID is invalid.`);
  }
  return result;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error(`Terminal ${label} are invalid.`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function sameDevicePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function validRemoteUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error('Device RPC response is too large.');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
