import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  SoloeApi,
  TerminalInputPayload,
  TerminalResizePayload
} from '@shared/types/ipc.js';
import type {
  CreateWorkerSessionRequest,
  ListObserverEventsRequest,
  ObservedAgentSnapshot,
  ObserverEvent,
  SendWorkerPromptRequest
} from '@shared/types/agents.js';
import type {
  SessionDraft,
  SessionId,
  SessionUpdate
} from '@shared/types/sessions.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStatusEvent
} from '@shared/types/terminal.js';

function subscribe<T>(channel: string, cb: (event: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.off(channel, handler);
  };
}

const soloe: SoloeApi = {
  sessions: {
    list: () => ipcRenderer.invoke(IpcChannels.sessions.list),
    get: (id: SessionId) => ipcRenderer.invoke(IpcChannels.sessions.get, id),
    create: (draft: SessionDraft) => ipcRenderer.invoke(IpcChannels.sessions.create, draft),
    update: (id: SessionId, patch: SessionUpdate) =>
      ipcRenderer.invoke(IpcChannels.sessions.update, id, patch),
    delete: (id: SessionId) => ipcRenderer.invoke(IpcChannels.sessions.delete, id),
    previewCommand: (id: SessionId) =>
      ipcRenderer.invoke(IpcChannels.sessions.previewCommand, id)
  },
  terminal: {
    start: (opts: TerminalStartOptions) => ipcRenderer.invoke(IpcChannels.terminal.start, opts),
    stop: (terminalId: TerminalId) => ipcRenderer.invoke(IpcChannels.terminal.stop, terminalId),
    restart: (sessionId: SessionId, opts) =>
      ipcRenderer.invoke(IpcChannels.terminal.restart, sessionId, opts),
    input: (payload: TerminalInputPayload) => ipcRenderer.invoke(IpcChannels.terminal.input, payload),
    resize: (payload: TerminalResizePayload) =>
      ipcRenderer.invoke(IpcChannels.terminal.resize, payload),
    listRunning: () => ipcRenderer.invoke(IpcChannels.terminal.listRunning),
    onOutput: (cb: (event: TerminalOutputEvent) => void) =>
      subscribe<TerminalOutputEvent>(IpcChannels.terminal.output, cb),
    onExit: (cb: (event: TerminalExitEvent) => void) =>
      subscribe<TerminalExitEvent>(IpcChannels.terminal.exit, cb),
    onStatus: (cb: (event: TerminalStatusEvent) => void) =>
      subscribe<TerminalStatusEvent>(IpcChannels.terminal.status, cb)
  },
  observer: {
    list: () => ipcRenderer.invoke(IpcChannels.observer.list),
    listEvents: (request?: ListObserverEventsRequest) =>
      ipcRenderer.invoke(IpcChannels.observer.listEvents, request),
    createWorkerSession: (request: CreateWorkerSessionRequest) =>
      ipcRenderer.invoke(IpcChannels.observer.createWorkerSession, request),
    sendWorkerPrompt: (request: SendWorkerPromptRequest) =>
      ipcRenderer.invoke(IpcChannels.observer.sendWorkerPrompt, request),
    getWorkerStatus: (workerId: string) =>
      ipcRenderer.invoke(IpcChannels.observer.getWorkerStatus, workerId),
    stopWorkerSession: (workerId: string) =>
      ipcRenderer.invoke(IpcChannels.observer.stopWorkerSession, workerId),
    onSnapshot: (cb: (snapshot: ObservedAgentSnapshot) => void) =>
      subscribe<ObservedAgentSnapshot>(IpcChannels.observer.snapshot, cb),
    onEvent: (cb: (event: ObserverEvent) => void) =>
      subscribe<ObserverEvent>(IpcChannels.observer.event, cb)
  },
  system: {
    openPath: (sessionId: SessionId) => ipcRenderer.invoke(IpcChannels.system.openPath, sessionId)
  }
};

contextBridge.exposeInMainWorld('soloe', soloe);
