import type {
  CreateWorkerSessionRequest,
  CreateWorkerSessionResult,
  ListObserverEventsRequest,
  ObservedAgentSnapshot,
  ObserverEvent,
  SendWorkerPromptRequest,
  WorkerStatusResult
} from './agents.js';
import type {
  GitAheadBehind,
  GitBranch,
  GitCheckoutRequest,
  GitChangeEvent,
  GitCommit,
  GitDirty,
  GitRecentCommitsRequest,
  GitRepoRequest,
  GitShortstat,
  GitStatus,
  GitStatusRequest,
  GitWorktree
} from './git.js';
import type {
  FileOpenRequest,
  FilePasteRequest,
  FileSearchRequest,
  FileSearchResult
} from './files.js';
import type { CrashLogSummary, DiagnosticItem } from './diagnostics.js';
import type {
  Project,
  ProjectDetectResult,
  ProjectDraft,
  ProjectId,
  ProjectOpenRequest,
  ProjectSuggestOptions,
  ProjectSuggestResult,
  ProjectUpdate
} from './projects.js';
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionRuntimeState,
  SessionUpdate
} from './sessions.js';
import type { Settings, SettingsUpdate } from './settings.js';
import type {
  SpawnSpec,
  TerminalDimensions,
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStartResult,
  TerminalStatusEvent
} from './terminal.js';
import type { SystemUsageSnapshot } from './system.js';

export const IpcChannels = {
  sessions: {
    list: 'sessions:list',
    listArchived: 'sessions:list-archived',
    get: 'sessions:get',
    create: 'sessions:create',
    update: 'sessions:update',
    delete: 'sessions:delete',
    previewCommand: 'sessions:preview-command'
  },
  terminal: {
    start: 'terminal:start',
    stop: 'terminal:stop',
    restart: 'terminal:restart',
    input: 'terminal:input',
    resize: 'terminal:resize',
    listRunning: 'terminal:list-running',
    output: 'terminal:output',
    exit: 'terminal:exit',
    status: 'terminal:status',
    location: 'terminal:location'
  },
  observer: {
    list: 'observer:list',
    listEvents: 'observer:list-events',
    createWorkerSession: 'observer:create-worker-session',
    sendWorkerPrompt: 'observer:send-worker-prompt',
    getWorkerStatus: 'observer:get-worker-status',
    stopWorkerSession: 'observer:stop-worker-session',
    snapshot: 'observer:snapshot',
    event: 'observer:event'
  },
  system: {
    openPath: 'system:open-path',
    saveText: 'system:save-text',
    openExternal: 'system:open-external',
    listWslDistros: 'system:list-wsl-distros',
    usage: 'system:usage'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    change: 'settings:change'
  },
  projects: {
    list: 'projects:list',
    get: 'projects:get',
    create: 'projects:create',
    open: 'projects:open',
    update: 'projects:update',
    delete: 'projects:delete',
    touch: 'projects:touch',
    detectFromPath: 'projects:detect-from-path',
    suggestPaths: 'projects:suggest-paths',
    change: 'projects:change'
  },
  git: {
    status: 'git:status',
    aheadBehind: 'git:ahead-behind',
    shortstat: 'git:shortstat',
    dirty: 'git:dirty',
    worktrees: 'git:worktrees',
    branches: 'git:branches',
    recentCommits: 'git:recent-commits',
    checkout: 'git:checkout',
    change: 'git:change'
  },
  files: {
    search: 'files:search',
    openInEditor: 'files:open-in-editor',
    pasteIntoTerminal: 'files:paste-into-terminal'
  },
  diagnostics: {
    list: 'diagnostics:list',
    crashLogs: 'diagnostics:crash-logs'
  },
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggle-maximize',
    zoomIn: 'window:zoom-in',
    zoomOut: 'window:zoom-out',
    close: 'window:close'
  },
  agentIntegration: {
    status: 'agent-integration:status',
    installClaude: 'agent-integration:install-claude',
    uninstallClaude: 'agent-integration:uninstall-claude',
    installCodex: 'agent-integration:install-codex',
    uninstallCodex: 'agent-integration:uninstall-codex',
    changed: 'agent-integration:changed'
  }
} as const;

export type IpcChannel =
  | (typeof IpcChannels.sessions)[keyof typeof IpcChannels.sessions]
  | (typeof IpcChannels.terminal)[keyof typeof IpcChannels.terminal]
  | (typeof IpcChannels.observer)[keyof typeof IpcChannels.observer]
  | (typeof IpcChannels.system)[keyof typeof IpcChannels.system]
  | (typeof IpcChannels.settings)[keyof typeof IpcChannels.settings]
  | (typeof IpcChannels.projects)[keyof typeof IpcChannels.projects]
  | (typeof IpcChannels.git)[keyof typeof IpcChannels.git]
  | (typeof IpcChannels.files)[keyof typeof IpcChannels.files]
  | (typeof IpcChannels.diagnostics)[keyof typeof IpcChannels.diagnostics]
  | (typeof IpcChannels.window)[keyof typeof IpcChannels.window]
  | (typeof IpcChannels.agentIntegration)[keyof typeof IpcChannels.agentIntegration];

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SessionsApi {
  list(): Promise<IpcResult<Session[]>>;
  listArchived(): Promise<IpcResult<Session[]>>;
  get(id: SessionId): Promise<IpcResult<Session | null>>;
  create(draft: SessionDraft): Promise<IpcResult<Session>>;
  update(id: SessionId, patch: SessionUpdate): Promise<IpcResult<Session>>;
  delete(id: SessionId): Promise<IpcResult<true>>;
  previewCommand(id: SessionId): Promise<IpcResult<SpawnSpec>>;
}

export interface TerminalInputPayload {
  terminalId: TerminalId;
  data: string;
}

export interface TerminalResizePayload {
  terminalId: TerminalId;
  dimensions: TerminalDimensions;
}

export interface TerminalApi {
  start(opts: TerminalStartOptions): Promise<IpcResult<TerminalStartResult>>;
  stop(terminalId: TerminalId): Promise<IpcResult<true>>;
  restart(sessionId: SessionId, opts?: { cols?: number; rows?: number }): Promise<IpcResult<TerminalStartResult>>;
  input(payload: TerminalInputPayload): Promise<IpcResult<true>>;
  resize(payload: TerminalResizePayload): Promise<IpcResult<true>>;
  listRunning(): Promise<IpcResult<SessionRuntimeState[]>>;

  onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  onStatus(listener: (event: TerminalStatusEvent) => void): () => void;
  onLocation(listener: (event: TerminalLocationEvent) => void): () => void;
}

export interface ObserverApi {
  list(): Promise<IpcResult<ObservedAgentSnapshot[]>>;
  listEvents(request?: ListObserverEventsRequest): Promise<IpcResult<ObserverEvent[]>>;
  createWorkerSession(request: CreateWorkerSessionRequest): Promise<IpcResult<CreateWorkerSessionResult>>;
  sendWorkerPrompt(request: SendWorkerPromptRequest): Promise<IpcResult<WorkerStatusResult>>;
  getWorkerStatus(workerId: string): Promise<IpcResult<WorkerStatusResult>>;
  stopWorkerSession(workerId: string): Promise<IpcResult<WorkerStatusResult>>;

  onSnapshot(listener: (snapshot: ObservedAgentSnapshot) => void): () => void;
  onEvent(listener: (event: ObserverEvent) => void): () => void;
}

export interface SystemApi {
  openPath(sessionId: SessionId): Promise<IpcResult<true>>;
  saveText(request: { defaultPath?: string; content: string }): Promise<IpcResult<true>>;
  openExternal(url: string): Promise<IpcResult<true>>;
  listWslDistros(): Promise<IpcResult<string[]>>;
  usage(): Promise<IpcResult<SystemUsageSnapshot>>;
}

export interface SettingsApi {
  get(): Promise<IpcResult<Settings>>;
  update(patch: SettingsUpdate): Promise<IpcResult<Settings>>;
  onChange(listener: (settings: Settings) => void): () => void;
}

export interface ProjectsApi {
  list(): Promise<IpcResult<Project[]>>;
  get(id: ProjectId): Promise<IpcResult<Project | null>>;
  create(draft: ProjectDraft): Promise<IpcResult<Project>>;
  open(request: ProjectOpenRequest): Promise<IpcResult<Project>>;
  update(id: ProjectId, patch: ProjectUpdate): Promise<IpcResult<Project>>;
  delete(id: ProjectId): Promise<IpcResult<true>>;
  touch(id: ProjectId): Promise<IpcResult<Project | null>>;
  detectFromPath(path: string): Promise<IpcResult<ProjectDetectResult>>;
  suggestPaths(
    query: string,
    options?: ProjectSuggestOptions
  ): Promise<IpcResult<ProjectSuggestResult>>;
  onChange(listener: (projects: Project[]) => void): () => void;
}

export interface GitApi {
  status(request: GitStatusRequest): Promise<IpcResult<GitStatus>>;
  aheadBehind(request: GitRepoRequest): Promise<IpcResult<GitAheadBehind>>;
  shortstat(request: GitRepoRequest): Promise<IpcResult<GitShortstat>>;
  dirty(request: GitRepoRequest): Promise<IpcResult<GitDirty>>;
  worktrees(request: GitRepoRequest): Promise<IpcResult<GitWorktree[]>>;
  branches(request: GitRepoRequest): Promise<IpcResult<GitBranch[]>>;
  recentCommits(request: GitRecentCommitsRequest): Promise<IpcResult<GitCommit[]>>;
  checkout(request: GitCheckoutRequest): Promise<IpcResult<GitStatus>>;
  onChange(listener: (event: GitChangeEvent) => void): () => void;
}

export interface FilesApi {
  search(request: FileSearchRequest): Promise<IpcResult<FileSearchResult[]>>;
  openInEditor(request: FileOpenRequest): Promise<IpcResult<true>>;
  pasteIntoTerminal(request: FilePasteRequest): Promise<IpcResult<true>>;
}

export interface DiagnosticsApi {
  list(): Promise<IpcResult<DiagnosticItem[]>>;
  crashLogs(): Promise<IpcResult<CrashLogSummary[]>>;
}

export interface WindowApi {
  minimize(): Promise<IpcResult<true>>;
  toggleMaximize(): Promise<IpcResult<true>>;
  zoomIn(): Promise<IpcResult<number>>;
  zoomOut(): Promise<IpcResult<number>>;
  close(): Promise<IpcResult<true>>;
}

export type AgentIntegrationClaudeScope = 'user' | 'project' | 'project_local';

export interface AgentIntegrationClaudeStatus {
  user: boolean;
  project: boolean;
  projectLocal: boolean;
}

export interface AgentIntegrationStatus {
  claude: AgentIntegrationClaudeStatus;
  codex: boolean;
}

export interface AgentIntegrationClaudeRequest {
  scope: AgentIntegrationClaudeScope;
  projectPath?: string;
}

export interface AgentIntegrationApi {
  status(projectPath?: string): Promise<IpcResult<AgentIntegrationStatus>>;
  installClaude(request: AgentIntegrationClaudeRequest): Promise<IpcResult<AgentIntegrationStatus>>;
  uninstallClaude(
    request: AgentIntegrationClaudeRequest
  ): Promise<IpcResult<AgentIntegrationStatus>>;
  installCodex(): Promise<IpcResult<AgentIntegrationStatus>>;
  uninstallCodex(): Promise<IpcResult<AgentIntegrationStatus>>;
  onChange(listener: (status: AgentIntegrationStatus) => void): () => void;
}

export interface SoloeApi {
  sessions: SessionsApi;
  terminal: TerminalApi;
  observer: ObserverApi;
  system: SystemApi;
  settings: SettingsApi;
  projects: ProjectsApi;
  git: GitApi;
  files: FilesApi;
  diagnostics: DiagnosticsApi;
  window: WindowApi;
  agentIntegration: AgentIntegrationApi;
}

declare global {
  interface Window {
    soloe: SoloeApi;
  }
}
