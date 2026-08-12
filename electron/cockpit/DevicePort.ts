import type {
  DeviceReadSnapshot,
  CockpitTerminalReplay
} from '@shared/types/cockpit.js';
import type {
  DeviceDescriptor,
  DeviceEventEnvelope,
  DeviceId,
  SessionRef,
  TerminalRef
} from '@shared/types/devices.js';
import type { DeviceCommandEnvelope, DeviceOperationReceipt } from '@shared/types/commands.js';
import type {
  DevicePlacedSessionRequest,
  DeviceSessionSourceUpdateRequest,
  DeviceWorkspaceIntent,
  DeviceWorkspacePlan
} from '@shared/types/workspaces.js';
import type { Session } from '@shared/types/sessions.js';
import type { TerminalStartResult } from '@shared/types/terminal.js';
import type { TerminalInputLease } from '@shared/types/terminal.js';
import type {
  CreateGitHubRepositoryIntent,
  GitHubOwner,
  GitHubProviderStatus,
  GitHubRepositoryOperationReceipt,
  GitHubRepositoryPlan
} from '@shared/types/providers.js';

export interface DevicePortStatus {
  deviceId: DeviceId;
  state: 'idle' | 'connecting' | 'ready' | 'offline' | 'incompatible' | 'disposed';
  descriptor: DeviceDescriptor | null;
  error?: string;
}

export interface DevicePort {
  readonly deviceId: DeviceId;
  readonly status: DevicePortStatus;

  connect(): Promise<DevicePortStatus>;
  snapshot(): Promise<DeviceReadSnapshot>;
  setTerminalOutputDemand(terminalIds: ReadonlySet<string>): Promise<void>;
  terminalInput(terminalId: string, data: string): Promise<void>;
  terminalAcquireInputLease?(
    terminalId: string,
    takeover?: boolean
  ): Promise<TerminalInputLease>;
  terminalResize(terminalId: string, cols: number, rows: number): Promise<void>;
  terminalReplay(terminalId: string, afterSeq?: number): Promise<CockpitTerminalReplay>;
  terminalStop(terminalId: string): Promise<void>;
  workspacePlan?(intent: DeviceWorkspaceIntent): Promise<DeviceWorkspacePlan>;
  workspaceExecute?(
    command: DeviceCommandEnvelope<DeviceWorkspaceIntent>
  ): Promise<DeviceOperationReceipt>;
  workspaceGetCommand?(cockpitId: string, commandId: string): Promise<DeviceOperationReceipt | null>;
  createSession?(request: DevicePlacedSessionRequest): Promise<Session>;
  startSession?(sessionId: string): Promise<TerminalStartResult>;
  rebindSessionSource?(request: DeviceSessionSourceUpdateRequest): Promise<Session>;
  githubProviderStatus?(): Promise<GitHubProviderStatus>;
  githubProviderOwners?(): Promise<GitHubOwner[]>;
  githubProviderPlan?(intent: CreateGitHubRepositoryIntent): Promise<GitHubRepositoryPlan>;
  githubProviderExecute?(
    command: DeviceCommandEnvelope<CreateGitHubRepositoryIntent>
  ): Promise<GitHubRepositoryOperationReceipt>;
  githubProviderGetCommand?(
    cockpitId: string,
    commandId: string
  ): Promise<DeviceOperationReceipt | null>;
  onEvent(listener: (event: DeviceEventEnvelope) => void): () => void;
  onStatus(listener: (status: DevicePortStatus) => void): () => void;
  dispose(): void | Promise<void>;
}

export function assertOwnedSessionRef(deviceId: DeviceId, ref: SessionRef): void {
  if (ref.deviceId !== deviceId) {
    throw new Error(`Session belongs to Device ${ref.deviceId}, not ${deviceId}.`);
  }
}

export function assertOwnedTerminalRef(deviceId: DeviceId, ref: TerminalRef): void {
  if (ref.deviceId !== deviceId) {
    throw new Error(`Terminal belongs to Device ${ref.deviceId}, not ${deviceId}.`);
  }
}
