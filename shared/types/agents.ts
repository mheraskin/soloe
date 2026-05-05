import type {
  AgentObservedState,
  AgentRuntimeProvider,
  SessionId,
  SessionRuntimeMode
} from './sessions.js';

export type AgentProvider = AgentRuntimeProvider;
export type ObserverSubjectKind = 'session' | 'worker';

export interface ObserverEvent {
  id: string;
  subjectId: string;
  subjectKind: ObserverSubjectKind;
  timestamp: string;
  state: AgentObservedState;
  summary: string;
  detail?: string;
}

export interface ObservedAgentSnapshot {
  id: string;
  runtimeMode: SessionRuntimeMode;
  subjectKind: ObserverSubjectKind;
  provider: AgentProvider | 'terminal';
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
}

export interface CreateWorkerSessionRequest {
  originSessionId: SessionId;
  provider: AgentProvider;
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
