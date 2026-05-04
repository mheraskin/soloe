export type SessionId = string;

export type RunMode = 'windows' | 'wsl';

export type ShellKind = 'auto' | 'bash' | 'zsh' | 'pwsh' | 'cmd' | 'custom';

export type SessionKind = 'standard_terminal' | 'claude_code' | 'codex';

export type SessionRuntimeMode = 'tui' | 'sdk_worker';

export type AgentRuntimeProvider = 'claude_code' | 'codex';
export type AgentRuntimeSource = 'managed' | 'attached';
export type AgentRuntimeStatus = 'active' | 'exited';

export interface AgentRuntimeInfo {
  provider: AgentRuntimeProvider;
  source: AgentRuntimeSource;
  status: AgentRuntimeStatus;
  providerThreadId?: string;
  startedAt?: string;
  lastEventAt?: string;
}

export const SESSION_COLOR_TOKENS = [
  'red',
  'orange',
  'amber',
  'yellow',
  'green',
  'teal',
  'cyan',
  'blue',
  'violet',
  'pink'
] as const;

export type SessionColor = (typeof SESSION_COLOR_TOKENS)[number];

export function isSessionColor(value: unknown): value is SessionColor {
  return typeof value === 'string'
    && (SESSION_COLOR_TOKENS as readonly string[]).includes(value);
}

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
  currentAgentRuntime?: AgentRuntimeInfo;
  lastEventAt?: string;
  confidence?: number;
  projectId?: string;
  tags?: string[];
  pinned?: boolean;
  archivedAt?: string;
  lastBranch?: string;
  sortIndex?: number;
  color?: SessionColor;
  // Auto-rename eligibility: true means the name was assigned (or never
  // touched) by Soloe and may be replaced by the auto-renamer; false means
  // the user has explicitly renamed and should be left alone. Undefined on
  // legacy sessions is treated as false to avoid surprise renames.
  autoNamed?: boolean;
  // True once the provider reports a submitted user prompt. New managed
  // Claude sessions use false until that hook arrives so empty provider ids
  // are not restored after restart.
  hasUserInput?: boolean;
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
