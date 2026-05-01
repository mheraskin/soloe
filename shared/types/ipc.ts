import type {
  Session,
  SessionDraft,
  SessionId,
  SessionRuntimeState,
  SessionUpdate
} from './sessions.js';
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
  system: {
    openPath: 'system:open-path'
  }
} as const;

export type IpcChannel =
  | (typeof IpcChannels.sessions)[keyof typeof IpcChannels.sessions]
  | (typeof IpcChannels.terminal)[keyof typeof IpcChannels.terminal]
  | (typeof IpcChannels.system)[keyof typeof IpcChannels.system];

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

export interface SystemApi {
  openPath(sessionId: SessionId): Promise<IpcResult<true>>;
}

export interface CockpitApi {
  sessions: SessionsApi;
  terminal: TerminalApi;
  system: SystemApi;
}

declare global {
  interface Window {
    cockpit: CockpitApi;
  }
}
