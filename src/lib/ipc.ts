import type { IpcResult } from '@shared/types/ipc.js';
import type {
  CreateWorkerSessionRequest,
  ListObserverEventsRequest,
  ObservedAgentSnapshot,
  ObserverEvent,
  SendWorkerPromptRequest
} from '@shared/types/agents.js';
import type { SessionDraft, SessionId, SessionUpdate } from '@shared/types/sessions.js';
import type { Settings, SettingsUpdate } from '@shared/types/settings.js';
import type {
  Project,
  ProjectDraft,
  ProjectId,
  ProjectUpdate
} from '@shared/types/projects.js';
import type {
  GitCheckoutRequest,
  GitChangeEvent,
  GitRecentCommitsRequest,
  GitRepoRequest,
  GitStatusRequest
} from '@shared/types/git.js';
import type {
  FileOpenRequest,
  FilePasteRequest,
  FileSearchRequest
} from '@shared/types/files.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStatusEvent
} from '@shared/types/terminal.js';

function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const c = window.soloe;

export const ipc = {
  sessions: {
    list: async () => unwrap(await c.sessions.list()),
    get: async (id: SessionId) => unwrap(await c.sessions.get(id)),
    create: async (draft: SessionDraft) => unwrap(await c.sessions.create(draft)),
    update: async (id: SessionId, patch: SessionUpdate) => unwrap(await c.sessions.update(id, patch)),
    delete: async (id: SessionId) => unwrap(await c.sessions.delete(id)),
    previewCommand: async (id: SessionId) => unwrap(await c.sessions.previewCommand(id))
  },
  terminal: {
    start: async (opts: TerminalStartOptions) => unwrap(await c.terminal.start(opts)),
    stop: async (terminalId: TerminalId) => unwrap(await c.terminal.stop(terminalId)),
    restart: async (sessionId: SessionId, opts?: { cols?: number; rows?: number }) =>
      unwrap(await c.terminal.restart(sessionId, opts)),
    input: async (terminalId: TerminalId, data: string) =>
      unwrap(await c.terminal.input({ terminalId, data })),
    resize: async (terminalId: TerminalId, cols: number, rows: number) =>
      unwrap(await c.terminal.resize({ terminalId, dimensions: { cols, rows } })),
    listRunning: async () => unwrap(await c.terminal.listRunning()),
    onOutput: (cb: (event: TerminalOutputEvent) => void) => c.terminal.onOutput(cb),
    onExit: (cb: (event: TerminalExitEvent) => void) => c.terminal.onExit(cb),
    onStatus: (cb: (event: TerminalStatusEvent) => void) => c.terminal.onStatus(cb)
  },
  observer: {
    list: async () => unwrap(await c.observer.list()),
    listEvents: async (request?: ListObserverEventsRequest) =>
      unwrap(await c.observer.listEvents(request)),
    createWorkerSession: async (request: CreateWorkerSessionRequest) =>
      unwrap(await c.observer.createWorkerSession(request)),
    sendWorkerPrompt: async (request: SendWorkerPromptRequest) =>
      unwrap(await c.observer.sendWorkerPrompt(request)),
    getWorkerStatus: async (workerId: string) => unwrap(await c.observer.getWorkerStatus(workerId)),
    stopWorkerSession: async (workerId: string) =>
      unwrap(await c.observer.stopWorkerSession(workerId)),
    onSnapshot: (cb: (snapshot: ObservedAgentSnapshot) => void) => c.observer.onSnapshot(cb),
    onEvent: (cb: (event: ObserverEvent) => void) => c.observer.onEvent(cb)
  },
  system: {
    openPath: async (sessionId: SessionId) => unwrap(await c.system.openPath(sessionId)),
    saveText: async (request: { defaultPath?: string; content: string }) =>
      unwrap(await c.system.saveText(request)),
    openExternal: async (url: string) => unwrap(await c.system.openExternal(url))
  },
  settings: {
    get: async () => unwrap(await c.settings.get()),
    update: async (patch: SettingsUpdate) => unwrap(await c.settings.update(patch)),
    onChange: (cb: (s: Settings) => void) => c.settings.onChange(cb)
  },
  projects: {
    list: async () => unwrap(await c.projects.list()),
    get: async (id: ProjectId) => unwrap(await c.projects.get(id)),
    create: async (draft: ProjectDraft) => unwrap(await c.projects.create(draft)),
    update: async (id: ProjectId, patch: ProjectUpdate) =>
      unwrap(await c.projects.update(id, patch)),
    delete: async (id: ProjectId) => unwrap(await c.projects.delete(id)),
    touch: async (id: ProjectId) => unwrap(await c.projects.touch(id)),
    detectFromPath: async (p: string) => unwrap(await c.projects.detectFromPath(p)),
    onChange: (cb: (projects: Project[]) => void) => c.projects.onChange(cb)
  },
  git: {
    status: async (request: GitStatusRequest) => unwrap(await c.git.status(request)),
    aheadBehind: async (request: GitRepoRequest) => unwrap(await c.git.aheadBehind(request)),
    shortstat: async (request: GitRepoRequest) => unwrap(await c.git.shortstat(request)),
    dirty: async (request: GitRepoRequest) => unwrap(await c.git.dirty(request)),
    worktrees: async (request: GitRepoRequest) => unwrap(await c.git.worktrees(request)),
    branches: async (request: GitRepoRequest) => unwrap(await c.git.branches(request)),
    recentCommits: async (request: GitRecentCommitsRequest) =>
      unwrap(await c.git.recentCommits(request)),
    checkout: async (request: GitCheckoutRequest) => unwrap(await c.git.checkout(request)),
    onChange: (cb: (event: GitChangeEvent) => void) => c.git.onChange(cb)
  },
  files: {
    search: async (request: FileSearchRequest) => unwrap(await c.files.search(request)),
    openInEditor: async (request: FileOpenRequest) =>
      unwrap(await c.files.openInEditor(request)),
    pasteIntoTerminal: async (request: FilePasteRequest) =>
      unwrap(await c.files.pasteIntoTerminal(request))
  },
  diagnostics: {
    list: async () => unwrap(await c.diagnostics.list()),
    crashLogs: async () => unwrap(await c.diagnostics.crashLogs())
  }
};
