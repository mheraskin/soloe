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
  Project,
  ProjectDetectResult,
  ProjectDraft,
  ProjectId,
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
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStartResult,
  TerminalStatusEvent
} from './terminal.js';

export const IpcChannels = {
  sessions: {
    list: 'sessions:list',
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
    status: 'terminal:status'
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
    openPath: 'system:open-path'
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
    update: 'projects:update',
    delete: 'projects:delete',
    touch: 'projects:touch',
    detectFromPath: 'projects:detect-from-path',
    change: 'projects:change'
  }
} as const;

export type IpcChannel =
  | (typeof IpcChannels.sessions)[keyof typeof IpcChannels.sessions]
  | (typeof IpcChannels.terminal)[keyof typeof IpcChannels.terminal]
  | (typeof IpcChannels.observer)[keyof typeof IpcChannels.observer]
  | (typeof IpcChannels.system)[keyof typeof IpcChannels.system]
  | (typeof IpcChannels.settings)[keyof typeof IpcChannels.settings]
  | (typeof IpcChannels.projects)[keyof typeof IpcChannels.projects];

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SessionsApi {
  list(): Promise<IpcResult<Session[]>>;
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
  update(id: ProjectId, patch: ProjectUpdate): Promise<IpcResult<Project>>;
  delete(id: ProjectId): Promise<IpcResult<true>>;
  touch(id: ProjectId): Promise<IpcResult<Project | null>>;
  detectFromPath(path: string): Promise<IpcResult<ProjectDetectResult>>;
  onChange(listener: (projects: Project[]) => void): () => void;
}

export interface SoloeApi {
  sessions: SessionsApi;
  terminal: TerminalApi;
  observer: ObserverApi;
  system: SystemApi;
  settings: SettingsApi;
  projects: ProjectsApi;
}

declare global {
  interface Window {
    soloe: SoloeApi;
  }
}
