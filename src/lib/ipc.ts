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
  ProjectOpenRequest,
  ProjectSuggestOptions,
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
  AgentIntegrationClaudeRequest,
  AgentIntegrationCodexRequest,
  AgentIntegrationStatus
} from '@shared/types/ipc.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStatusEvent
} from '@shared/types/terminal.js';

function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

export function toIpcPayload<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => toIpcPayload(item)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = toIpcPayload(item);
  }
  return out as T;
}

const c = globalThis.window?.soloe as Window['soloe'];

export const ipc = {
  sessions: {
    list: async () => unwrap(await c.sessions.list()),
    listArchived: async () => unwrap(await c.sessions.listArchived()),
    get: async (id: SessionId) => unwrap(await c.sessions.get(id)),
    create: async (draft: SessionDraft) => unwrap(await c.sessions.create(toIpcPayload(draft))),
    update: async (id: SessionId, patch: SessionUpdate) =>
      unwrap(await c.sessions.update(id, toIpcPayload(patch))),
    delete: async (id: SessionId) => unwrap(await c.sessions.delete(id)),
    reorder: async (orderedIds: SessionId[]) =>
      unwrap(await c.sessions.reorder([...orderedIds])),
    previewCommand: async (id: SessionId) => unwrap(await c.sessions.previewCommand(id))
  },
  terminal: {
    start: async (opts: TerminalStartOptions) => unwrap(await c.terminal.start(toIpcPayload(opts))),
    stop: async (terminalId: TerminalId) => unwrap(await c.terminal.stop(terminalId)),
    restart: async (sessionId: SessionId, opts?: { cols?: number; rows?: number }) =>
      unwrap(await c.terminal.restart(sessionId, opts ? toIpcPayload(opts) : undefined)),
    input: async (terminalId: TerminalId, data: string) =>
      unwrap(await c.terminal.input(toIpcPayload({ terminalId, data }))),
    resize: async (terminalId: TerminalId, cols: number, rows: number) =>
      unwrap(await c.terminal.resize(toIpcPayload({ terminalId, dimensions: { cols, rows } }))),
    listRunning: async () => unwrap(await c.terminal.listRunning()),
    onOutput: (cb: (event: TerminalOutputEvent) => void) => c.terminal.onOutput(cb),
    onExit: (cb: (event: TerminalExitEvent) => void) => c.terminal.onExit(cb),
    onStatus: (cb: (event: TerminalStatusEvent) => void) => c.terminal.onStatus(cb),
    onLocation: (cb: (event: TerminalLocationEvent) => void) => c.terminal.onLocation(cb)
  },
  observer: {
    list: async () => unwrap(await c.observer.list()),
    listEvents: async (request?: ListObserverEventsRequest) =>
      unwrap(await c.observer.listEvents(request ? toIpcPayload(request) : undefined)),
    createWorkerSession: async (request: CreateWorkerSessionRequest) =>
      unwrap(await c.observer.createWorkerSession(toIpcPayload(request))),
    sendWorkerPrompt: async (request: SendWorkerPromptRequest) =>
      unwrap(await c.observer.sendWorkerPrompt(toIpcPayload(request))),
    getWorkerStatus: async (workerId: string) => unwrap(await c.observer.getWorkerStatus(workerId)),
    stopWorkerSession: async (workerId: string) =>
      unwrap(await c.observer.stopWorkerSession(workerId)),
    onSnapshot: (cb: (snapshot: ObservedAgentSnapshot) => void) => c.observer.onSnapshot(cb),
    onEvent: (cb: (event: ObserverEvent) => void) => c.observer.onEvent(cb)
  },
  system: {
    openPath: async (sessionId: SessionId) => unwrap(await c.system.openPath(sessionId)),
    saveText: async (request: { defaultPath?: string; content: string }) =>
      unwrap(await c.system.saveText(toIpcPayload(request))),
    openExternal: async (url: string) => unwrap(await c.system.openExternal(url)),
    listWslDistros: async () => unwrap(await c.system.listWslDistros()),
    usage: async () => unwrap(await c.system.usage())
  },
  settings: {
    get: async () => unwrap(await c.settings.get()),
    update: async (patch: SettingsUpdate) => unwrap(await c.settings.update(toIpcPayload(patch))),
    onChange: (cb: (s: Settings) => void) => c.settings.onChange(cb)
  },
  projects: {
    list: async () => unwrap(await c.projects.list()),
    get: async (id: ProjectId) => unwrap(await c.projects.get(id)),
    create: async (draft: ProjectDraft) => unwrap(await c.projects.create(toIpcPayload(draft))),
    open: async (request: ProjectOpenRequest) => unwrap(await c.projects.open(toIpcPayload(request))),
    update: async (id: ProjectId, patch: ProjectUpdate) =>
      unwrap(await c.projects.update(id, toIpcPayload(patch))),
    delete: async (id: ProjectId) => unwrap(await c.projects.delete(id)),
    touch: async (id: ProjectId) => unwrap(await c.projects.touch(id)),
    reorder: async (orderedIds: ProjectId[]) =>
      unwrap(await c.projects.reorder([...orderedIds])),
    detectFromPath: async (p: string) => unwrap(await c.projects.detectFromPath(p)),
    suggestPaths: async (query: string, options?: ProjectSuggestOptions) =>
      unwrap(await c.projects.suggestPaths(query, options ? toIpcPayload(options) : undefined)),
    onChange: (cb: (projects: Project[]) => void) => c.projects.onChange(cb)
  },
  git: {
    status: async (request: GitStatusRequest) => unwrap(await c.git.status(toIpcPayload(request))),
    aheadBehind: async (request: GitRepoRequest) =>
      unwrap(await c.git.aheadBehind(toIpcPayload(request))),
    shortstat: async (request: GitRepoRequest) =>
      unwrap(await c.git.shortstat(toIpcPayload(request))),
    dirty: async (request: GitRepoRequest) => unwrap(await c.git.dirty(toIpcPayload(request))),
    worktrees: async (request: GitRepoRequest) =>
      unwrap(await c.git.worktrees(toIpcPayload(request))),
    branches: async (request: GitRepoRequest) =>
      unwrap(await c.git.branches(toIpcPayload(request))),
    recentCommits: async (request: GitRecentCommitsRequest) =>
      unwrap(await c.git.recentCommits(toIpcPayload(request))),
    checkout: async (request: GitCheckoutRequest) =>
      unwrap(await c.git.checkout(toIpcPayload(request))),
    onChange: (cb: (event: GitChangeEvent) => void) => c.git.onChange(cb)
  },
  files: {
    search: async (request: FileSearchRequest) => unwrap(await c.files.search(toIpcPayload(request))),
    openInEditor: async (request: FileOpenRequest) =>
      unwrap(await c.files.openInEditor(toIpcPayload(request))),
    pasteIntoTerminal: async (request: FilePasteRequest) =>
      unwrap(await c.files.pasteIntoTerminal(toIpcPayload(request)))
  },
  diagnostics: {
    list: async () => unwrap(await c.diagnostics.list()),
    crashLogs: async () => unwrap(await c.diagnostics.crashLogs())
  },
  window: {
    minimize: async () => unwrap(await c.window.minimize()),
    toggleMaximize: async () => unwrap(await c.window.toggleMaximize()),
    zoomIn: async () => unwrap(await c.window.zoomIn()),
    zoomOut: async () => unwrap(await c.window.zoomOut()),
    close: async () => unwrap(await c.window.close())
  },
  agentIntegration: {
    status: async () => unwrap(await c.agentIntegration.status()),
    installClaude: async (request: AgentIntegrationClaudeRequest) =>
      unwrap(await c.agentIntegration.installClaude(toIpcPayload(request))),
    uninstallClaude: async (request: AgentIntegrationClaudeRequest) =>
      unwrap(await c.agentIntegration.uninstallClaude(toIpcPayload(request))),
    installCodex: async (request: AgentIntegrationCodexRequest) =>
      unwrap(await c.agentIntegration.installCodex(toIpcPayload(request))),
    uninstallCodex: async (request: AgentIntegrationCodexRequest) =>
      unwrap(await c.agentIntegration.uninstallCodex(toIpcPayload(request))),
    onChange: (cb: (status: AgentIntegrationStatus) => void) =>
      c.agentIntegration.onChange(cb)
  }
};
