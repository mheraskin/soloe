import type { SessionSource } from './workspaces.js';
import type { SessionRef } from './devices.js';

export type SessionId = string;

/** `wsl` is hosted by Windows; the other modes are native desktop runtimes. */
export type RunMode = 'windows' | 'linux' | 'macos' | 'wsl';

export type ShellKind = 'auto' | 'bash' | 'zsh' | 'pwsh' | 'cmd' | 'custom';

export type AgentRuntimeProvider =
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'grok_build';
export type SessionLaunchKind = 'terminal' | AgentRuntimeProvider;
export type SessionKind = 'standard_terminal' | AgentRuntimeProvider;

export type SessionRuntimeMode = 'tui' | 'sdk_worker';

export type AgentRuntimeStatus = 'active' | 'exited';

export interface AgentRuntimeInfo {
  provider: AgentRuntimeProvider;
  status: AgentRuntimeStatus;
  providerThreadId?: string;
  startedAt?: string;
  lastEventAt?: string;
}

export interface TerminalLaunch {
  type: 'terminal';
  shell: ShellKind;
  command?: string;
  args?: string[];
}

export type ClaudeResumeMode = 'new' | 'resume_by_name' | 'resume_by_id' | 'resume_last';
export type CodexResumeMode = 'new' | 'resume_last' | 'resume_by_id';
export type CursorResumeMode = 'new' | 'resume_last' | 'resume_by_id';
export type OpenCodeResumeMode = 'new' | 'resume_last' | 'resume_by_id';
export type GrokBuildResumeMode = 'new' | 'resume_last' | 'resume_by_id';
export type CodexReasoningEffort = 'low' | 'medium' | 'high';
export type CursorMode = 'agent' | 'plan' | 'ask';

export interface AgentLaunch {
  type: 'agent';
  provider: AgentRuntimeProvider;
  resumeMode:
    | ClaudeResumeMode
    | CodexResumeMode
    | CursorResumeMode
    | OpenCodeResumeMode
    | GrokBuildResumeMode;
  claudeSessionName?: string;
  claudeSessionId?: string;
  codexSessionId?: string;
  cursorSessionId?: string;
  openCodeSessionId?: string;
  grokSessionId?: string;
  cursorMode?: CursorMode;
  fullscreenTui?: boolean;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  extraArgs?: string[];
}

export type SessionLaunch = TerminalLaunch | AgentLaunch;

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
  | 'usage_limited'
  | 'completed'
  | 'failed'
  | 'exited';

export interface Session {
  id: SessionId;
  /** Device-authoritative entity version; absent only on pre-v2 wire compatibility records. */
  version?: number;
  /** Exact physical source binding; absent until legacy adoption or explicit placement. */
  source?: SessionSource;
  launch: SessionLaunch;
  kind?: SessionKind;
  resumeMode?:
    | ClaudeResumeMode
    | CodexResumeMode
    | CursorResumeMode
    | OpenCodeResumeMode
    | GrokBuildResumeMode;
  runtimeMode?: SessionRuntimeMode;
  name: string;
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  createdAt: string;
  lastUsedAt: string;
  originSessionId?: SessionId;
  /** Composite provenance for a Successor Session; safe across Device-local ID collisions. */
  originSessionRef?: SessionRef;
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
  // True once the provider reports a submitted user prompt. New Claude
  // launches use false until that hook arrives so their preassigned id is
  // launched with --session-id rather than treated as a resumable thread.
  hasUserInput?: boolean;
}

export type SessionDraft = Omit<Session, 'id' | 'createdAt' | 'lastUsedAt'>;

export type SessionUpdate = Partial<Omit<Session, 'id' | 'createdAt' | 'version' | 'source'>>;

export type SessionStatus = 'stopped' | 'starting' | 'running' | 'exited' | 'error';

export interface SessionRuntimeState {
  sessionId: SessionId;
  runtimeMode?: SessionRuntimeMode;
  /** Current Terminal directory; the Session's `cwd` remains its Worktree. */
  cwd?: string;
  observedState?: AgentObservedState;
  status: SessionStatus;
  terminalId: string | null;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: number | null;
  error?: string;
}

export function isAgentProvider(value: unknown): value is AgentRuntimeProvider {
  return value === 'claude_code'
    || value === 'codex'
    || value === 'cursor'
    || value === 'opencode'
    || value === 'grok_build';
}

export function launchKind(session: Session | SessionDraft): SessionLaunchKind {
  return session.launch.type === 'terminal' ? 'terminal' : session.launch.provider;
}

export function launchProvider(session: Session | SessionDraft): AgentRuntimeProvider | null {
  return session.launch.type === 'agent' ? session.launch.provider : null;
}

export function effectiveAgentProvider(session: Session): AgentRuntimeProvider | null {
  return session.currentAgentRuntime?.provider ?? launchProvider(session);
}
