import type {
  AgentObservedState,
  AgentRuntimeProvider,
  SessionId,
  SessionRuntimeMode
} from './sessions.js';

export type AgentProvider = AgentRuntimeProvider;
export type WorkerAgentProvider = Exclude<AgentProvider, 'opencode' | 'grok_build'>;
export type ObserverSubjectKind = 'session' | 'worker';

export type InteractiveAgentLifecycle = 'starting' | 'running' | 'exited' | 'failed';
export type InteractiveAgentTurn = 'idle' | 'working' | 'running_tool';
export type InteractiveAgentObservation = 'exact' | 'degraded';

export type InteractiveAgentAttention =
  | { kind: 'none' }
  | { kind: 'approval'; requestKey?: string; summary?: string }
  | { kind: 'user_input'; requestKey?: string; summary?: string }
  | { kind: 'usage_limit'; summary?: string }
  | { kind: 'error'; summary?: string };

export interface InteractiveAgentProjection {
  lifecycle: InteractiveAgentLifecycle;
  turn: InteractiveAgentTurn;
  attention: InteractiveAgentAttention;
  providerSessionId?: string;
  providerTurnId?: string;
  tool?: { id?: string; name: string };
  observation: InteractiveAgentObservation;
  lastEventAt: string;
}

export interface ObserverEvent {
  id: string;
  subjectId: string;
  subjectKind: ObserverSubjectKind;
  timestamp: string;
  state: AgentObservedState;
  summary: string;
  detail?: string;
  // Effective approval behavior resolved for the observed session or worker.
  autoApprovesPermissions?: boolean;
}

export interface ObservedAgentSnapshot {
  id: string;
  runtimeMode: SessionRuntimeMode;
  subjectKind: ObserverSubjectKind;
  provider: AgentProvider | 'terminal';
  // Effective approval behavior resolved for the observed session or worker.
  autoApprovesPermissions?: boolean;
  state: AgentObservedState;
  sessionId?: SessionId;
  originSessionId?: SessionId;
  workerId?: string;
  providerThreadId?: string;
  transcriptPath?: string;
  promptSummary?: string;
  resultSummary?: string;
  lastEventAt?: string;
  confidence?: number;
  error?: string;
  usageLimit?: AgentUsageLimit;
  /** Orthogonal interactive-CLI facts; absent on older persisted snapshots. */
  interactive?: InteractiveAgentProjection;
}

export interface AgentUsageLimit {
  message: string;
  resetAtLabel?: string;
  detectedAt: string;
  detectorVersion?: number;
  matchedText?: string;
}

export interface CreateWorkerSessionRequest {
  originSessionId: SessionId;
  provider: WorkerAgentProvider;
  cwd?: string;
  promptSummary?: string;
}

export interface CreateWorkerSessionResult {
  workerId: string;
  snapshot: ObservedAgentSnapshot;
}

export interface SendWorkerPromptRequest {
  workerId: string;
  prompt: string;
}

export interface WorkerStatusResult {
  snapshot: ObservedAgentSnapshot | null;
}

export interface ListWorkerEventsRequest {
  workerId: string;
  limit?: number;
}

export interface ListObserverEventsRequest {
  subjectId?: string;
  limit?: number;
}
