export type SessionId = string;

export type RunMode = 'windows' | 'wsl';

export type ShellKind = 'auto' | 'bash' | 'zsh' | 'pwsh' | 'cmd' | 'custom';

export type SessionKind = 'standard_terminal' | 'claude_code' | 'codex';

export type SessionRuntimeMode = 'tui' | 'sdk_worker';

export type AgentObservedState =
  | 'starting'
  | 'idle'
  | 'working'
  | 'running_tool'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'exited';

export interface SessionBase {
  id: SessionId;
  kind: SessionKind;
  runtimeMode?: SessionRuntimeMode;
  name: string;
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  createdAt: string;
  lastUsedAt: string;
  originSessionId?: SessionId;
  workerId?: string;
  providerThreadId?: string;
  transcriptPath?: string;
  lastEventAt?: string;
  confidence?: number;
}

export interface StandardTerminalSession extends SessionBase {
  kind: 'standard_terminal';
  shell: ShellKind;
  command?: string;
  args?: string[];
}

export type ClaudeResumeMode = 'new' | 'resume_by_name' | 'resume_by_id' | 'resume_last';

export interface ClaudeCodeSession extends SessionBase {
  kind: 'claude_code';
  resumeMode: ClaudeResumeMode;
  claudeSessionName?: string;
  claudeSessionId?: string;
  fullscreenTui?: boolean;
}

export type CodexResumeMode = 'new' | 'resume_last' | 'resume_by_id';
export type CodexReasoningEffort = 'low' | 'medium' | 'high';

export interface CodexSession extends SessionBase {
  kind: 'codex';
  resumeMode: CodexResumeMode;
  codexSessionId?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export type Session = StandardTerminalSession | ClaudeCodeSession | CodexSession;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SessionDraft = DistributiveOmit<Session, 'id' | 'createdAt' | 'lastUsedAt'>;

export type SessionUpdate = DistributiveOmit<Partial<Session>, 'id' | 'kind' | 'createdAt'>;

export type SessionStatus = 'stopped' | 'starting' | 'running' | 'exited' | 'error';

export interface SessionRuntimeState {
  sessionId: SessionId;
  runtimeMode?: SessionRuntimeMode;
  observedState?: AgentObservedState;
  status: SessionStatus;
  terminalId: string | null;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: number | null;
  error?: string;
}

export function isStandardTerminalSession(s: Session): s is StandardTerminalSession {
  return s.kind === 'standard_terminal';
}

export function isClaudeCodeSession(s: Session): s is ClaudeCodeSession {
  return s.kind === 'claude_code';
}

export function isCodexSession(s: Session): s is CodexSession {
  return s.kind === 'codex';
}
