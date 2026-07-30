import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  AgentIntegrationClaudeRequest,
  AgentIntegrationCodexRequest,
  AgentIntegrationStatus,
  SoloeApi,
  TerminalInputPayload,
  TerminalOutputDemandPayload,
  TerminalResizePayload,
  ToastNotification
} from '@shared/types/ipc.js';
import type {
  CommentsRpcRequest,
  CommentsRpcResponse
} from '@shared/types/comments-rpc.js';
import type {
  DiffRpcRequest,
  DiffRpcResponse
} from '@shared/types/diff-rpc.js';
import type {
  CreateWorkerSessionRequest,
  ListObserverEventsRequest,
  ObservedAgentSnapshot,
  ObserverEvent,
  SendWorkerPromptRequest
} from '@shared/types/agents.js';
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionUpdate
} from '@shared/types/sessions.js';
import type { Settings, SettingsUpdate } from '@shared/types/settings.js';
import type { SystemUsageRequest } from '@shared/types/system.js';
import type {
  Project,
  ProjectDraft,
  ProjectId,
  ProjectSuggestOptions,
  ProjectUpdate
} from '@shared/types/projects.js';
import type { NotesChangeEvent } from '@shared/types/notes.js';
import type {
  FeatureChangeEvent,
  FeatureScanRequest,
  FeatureSetBranchStatusRequest,
  FeatureSetIssueStatusRequest
} from '@shared/types/features.js';
import type {
  VaultDeleteRequest,
  VaultGetSecretRequest,
  VaultListRequest,
  VaultSaveRequest,
  VaultUpdateRequest
} from '@shared/types/vault.js';
import type {
  CloseDevToolsRequest,
  DisableDeviceEmulationRequest,
  EnableDeviceEmulationRequest,
  OpenDevToolsRequest,
  SetDevToolsLayoutRequest,
  SetUserAgentRequest
} from '@shared/types/browser.js';
import type {
  CommitsBetweenRequest,
  FileBlameRequest,
  FileDiffRequest,
  DiscardFilesRequest,
  FileLinesRequest,
  GitCheckoutRequest,
  GitChangeEvent,
  GitCommitRequest,
  GitRecentCommitsRequest,
  GitObservationDemandRequest,
  GitRemoteOpRequest,
  GitRefHistoryRequest,
  GitRepoRequest,
  GitStatusRequest,
  RangeChangesRequest,
  ReviewDiffsRequest,
  ResolveRefsRequest,
  StageFilesRequest,
  WorkingChangesRequest,
  WorkingTreeSnapshotRequest
} from '@shared/types/git.js';
import type {
  FileOpenRequest,
  FileReadRequest,
  FileTreeRequest,
  FileWriteRequest,
  ImagePasteRequest,
  FilePasteRequest,
  FileSearchRequest
} from '@shared/types/files.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import type {
  AskFollowUpChunk,
  AskFollowUpRequest,
  GetOverviewRequest,
  RegenerateOverviewRequest
} from '@shared/types/overview.js';

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
    listArchived: () => ipcRenderer.invoke(IpcChannels.sessions.listArchived),
    get: (id: SessionId) => ipcRenderer.invoke(IpcChannels.sessions.get, id),
    create: (draft: SessionDraft) => ipcRenderer.invoke(IpcChannels.sessions.create, draft),
    update: (id: SessionId, patch: SessionUpdate) =>
      ipcRenderer.invoke(IpcChannels.sessions.update, id, patch),
    delete: (id: SessionId) => ipcRenderer.invoke(IpcChannels.sessions.delete, id),
    reorder: (orderedIds: SessionId[]) =>
      ipcRenderer.invoke(IpcChannels.sessions.reorder, orderedIds),
    previewCommand: (id: SessionId) =>
      ipcRenderer.invoke(IpcChannels.sessions.previewCommand, id),
    onChange: (cb: (session: Session) => void) =>
      subscribe<Session>(IpcChannels.sessions.changed, cb)
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
    replay: (terminalId: TerminalId, afterSeq?: number) =>
      ipcRenderer.invoke(IpcChannels.terminal.replay, terminalId, afterSeq),
    setOutputDemand: (payload: TerminalOutputDemandPayload) =>
      ipcRenderer.invoke(IpcChannels.terminal.outputDemand, payload),
    onOutput: (cb: (event: TerminalOutputEvent) => void) =>
      subscribe<TerminalOutputEvent>(IpcChannels.terminal.output, cb),
    onExit: (cb: (event: TerminalExitEvent) => void) =>
      subscribe<TerminalExitEvent>(IpcChannels.terminal.exit, cb),
    onStatus: (cb: (event: TerminalStatusEvent) => void) =>
      subscribe<TerminalStatusEvent>(IpcChannels.terminal.status, cb),
    onLocation: (cb: (event: TerminalLocationEvent) => void) =>
      subscribe<TerminalLocationEvent>(IpcChannels.terminal.location, cb)
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
    platform: () => ipcRenderer.invoke(IpcChannels.system.platform),
    openPath: (sessionId: SessionId) => ipcRenderer.invoke(IpcChannels.system.openPath, sessionId),
    saveText: (request: { defaultPath?: string; content: string }) =>
      ipcRenderer.invoke(IpcChannels.system.saveText, request),
    openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.system.openExternal, url),
    listWslDistros: () => ipcRenderer.invoke(IpcChannels.system.listWslDistros),
    usage: (request?: SystemUsageRequest) => ipcRenderer.invoke(IpcChannels.system.usage, request)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.settings.get),
    update: (patch: SettingsUpdate) => ipcRenderer.invoke(IpcChannels.settings.update, patch),
    onChange: (cb: (settings: Settings) => void) =>
      subscribe<Settings>(IpcChannels.settings.change, cb)
  },
  projects: {
    list: () => ipcRenderer.invoke(IpcChannels.projects.list),
    get: (id: ProjectId) => ipcRenderer.invoke(IpcChannels.projects.get, id),
    create: (draft: ProjectDraft) => ipcRenderer.invoke(IpcChannels.projects.create, draft),
    open: (request) => ipcRenderer.invoke(IpcChannels.projects.open, request),
    update: (id: ProjectId, patch: ProjectUpdate) =>
      ipcRenderer.invoke(IpcChannels.projects.update, id, patch),
    delete: (id: ProjectId) => ipcRenderer.invoke(IpcChannels.projects.delete, id),
    touch: (id: ProjectId) => ipcRenderer.invoke(IpcChannels.projects.touch, id),
    reorder: (orderedIds: ProjectId[]) =>
      ipcRenderer.invoke(IpcChannels.projects.reorder, orderedIds),
    refreshFavicons: (id: ProjectId) =>
      ipcRenderer.invoke(IpcChannels.projects.refreshFavicons, id),
    readFavicon: (id: ProjectId, relativePath: string) =>
      ipcRenderer.invoke(IpcChannels.projects.readFavicon, id, relativePath),
    detectFromPath: (p: string) => ipcRenderer.invoke(IpcChannels.projects.detectFromPath, p),
    suggestPaths: (query: string, options?: ProjectSuggestOptions) =>
      ipcRenderer.invoke(IpcChannels.projects.suggestPaths, query, options),
    onChange: (cb: (projects: Project[]) => void) =>
      subscribe<Project[]>(IpcChannels.projects.change, cb)
  },
  notes: {
    list: (projectId: ProjectId) => ipcRenderer.invoke(IpcChannels.notes.list, projectId),
    read: (projectId: ProjectId, filename: string) =>
      ipcRenderer.invoke(IpcChannels.notes.read, projectId, filename),
    write: (projectId: ProjectId, filename: string, content: string) =>
      ipcRenderer.invoke(IpcChannels.notes.write, projectId, filename, content),
    rename: (projectId: ProjectId, oldName: string, newName: string) =>
      ipcRenderer.invoke(IpcChannels.notes.rename, projectId, oldName, newName),
    delete: (projectId: ProjectId, filename: string) =>
      ipcRenderer.invoke(IpcChannels.notes.delete, projectId, filename),
    saveImage: (projectId: ProjectId, mimeType: string, dataBase64: string) =>
      ipcRenderer.invoke(IpcChannels.notes.saveImage, projectId, mimeType, dataBase64),
    readImage: (absolutePath: string) =>
      ipcRenderer.invoke(IpcChannels.notes.readImage, absolutePath),
    cleanupImages: (projectId: ProjectId, extraReferences: string[]) =>
      ipcRenderer.invoke(IpcChannels.notes.cleanupImages, projectId, extraReferences),
    onChange: (cb: (event: NotesChangeEvent) => void) =>
      subscribe<NotesChangeEvent>(IpcChannels.notes.change, cb)
  },
  git: {
    status: (request: GitStatusRequest) => ipcRenderer.invoke(IpcChannels.git.status, request),
    aheadBehind: (request: GitRepoRequest) =>
      ipcRenderer.invoke(IpcChannels.git.aheadBehind, request),
    shortstat: (request: GitRepoRequest) => ipcRenderer.invoke(IpcChannels.git.shortstat, request),
    dirty: (request: GitRepoRequest) => ipcRenderer.invoke(IpcChannels.git.dirty, request),
    worktrees: (request: GitRepoRequest) => ipcRenderer.invoke(IpcChannels.git.worktrees, request),
    branches: (request: GitRepoRequest) => ipcRenderer.invoke(IpcChannels.git.branches, request),
    recentCommits: (request: GitRecentCommitsRequest) =>
      ipcRenderer.invoke(IpcChannels.git.recentCommits, request),
    refHistory: (request: GitRefHistoryRequest) =>
      ipcRenderer.invoke(IpcChannels.git.refHistory, request),
    commitsBetween: (request: CommitsBetweenRequest) =>
      ipcRenderer.invoke(IpcChannels.git.commitsBetween, request),
    rangeChanges: (request: RangeChangesRequest) =>
      ipcRenderer.invoke(IpcChannels.git.rangeChanges, request),
    resolveRefs: (request: ResolveRefsRequest) =>
      ipcRenderer.invoke(IpcChannels.git.resolveRefs, request),
    checkout: (request: GitCheckoutRequest) => ipcRenderer.invoke(IpcChannels.git.checkout, request),
    workingChanges: (request: WorkingChangesRequest) =>
      ipcRenderer.invoke(IpcChannels.git.workingChanges, request),
    workingTreeSnapshot: (request: WorkingTreeSnapshotRequest) =>
      ipcRenderer.invoke(IpcChannels.git.workingTreeSnapshot, request),
    setObservationDemand: (request: GitObservationDemandRequest) =>
      ipcRenderer.invoke(IpcChannels.git.observationDemand, request),
    fileDiff: (request: FileDiffRequest) =>
      ipcRenderer.invoke(IpcChannels.git.fileDiff, request),
    reviewDiffs: (request: ReviewDiffsRequest) =>
      ipcRenderer.invoke(IpcChannels.git.reviewDiffs, request),
    fileBlame: (request: FileBlameRequest) =>
      ipcRenderer.invoke(IpcChannels.git.fileBlame, request),
    fileLines: (request: FileLinesRequest) =>
      ipcRenderer.invoke(IpcChannels.git.fileLines, request),
    stageFiles: (request: StageFilesRequest) =>
      ipcRenderer.invoke(IpcChannels.git.stageFiles, request),
    unstageFiles: (request: StageFilesRequest) =>
      ipcRenderer.invoke(IpcChannels.git.unstageFiles, request),
    discardFiles: (request: DiscardFilesRequest) =>
      ipcRenderer.invoke(IpcChannels.git.discardFiles, request),
    commit: (request: GitCommitRequest) => ipcRenderer.invoke(IpcChannels.git.commit, request),
    push: (request: GitRemoteOpRequest) => ipcRenderer.invoke(IpcChannels.git.push, request),
    pull: (request: GitRemoteOpRequest) => ipcRenderer.invoke(IpcChannels.git.pull, request),
    fetch: (request: GitRemoteOpRequest) => ipcRenderer.invoke(IpcChannels.git.fetch, request),
    onChange: (cb: (event: GitChangeEvent) => void) =>
      subscribe<GitChangeEvent>(IpcChannels.git.change, cb)
  },
  files: {
    search: (request: FileSearchRequest) => ipcRenderer.invoke(IpcChannels.files.search, request),
    openInEditor: (request: FileOpenRequest) =>
      ipcRenderer.invoke(IpcChannels.files.openInEditor, request),
    pasteIntoTerminal: (request: FilePasteRequest) =>
      ipcRenderer.invoke(IpcChannels.files.pasteIntoTerminal, request),
    pasteImagesIntoTerminal: (request: ImagePasteRequest) =>
      ipcRenderer.invoke(IpcChannels.files.pasteImagesIntoTerminal, request),
    listTree: (request: FileTreeRequest) => ipcRenderer.invoke(IpcChannels.files.listTree, request),
    readFile: (request: FileReadRequest) => ipcRenderer.invoke(IpcChannels.files.readFile, request),
    writeFile: (request: FileWriteRequest) => ipcRenderer.invoke(IpcChannels.files.writeFile, request)
  },
  diagnostics: {
    list: () => ipcRenderer.invoke(IpcChannels.diagnostics.list),
    crashLogs: () => ipcRenderer.invoke(IpcChannels.diagnostics.crashLogs)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IpcChannels.window.minimize),
    toggleMaximize: () => ipcRenderer.invoke(IpcChannels.window.toggleMaximize),
    zoomIn: () => ipcRenderer.invoke(IpcChannels.window.zoomIn),
    zoomOut: () => ipcRenderer.invoke(IpcChannels.window.zoomOut),
    close: () => ipcRenderer.invoke(IpcChannels.window.close)
  },
  agentIntegration: {
    status: () => ipcRenderer.invoke(IpcChannels.agentIntegration.status),
    installClaude: (request: AgentIntegrationClaudeRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.installClaude, request),
    uninstallClaude: (request: AgentIntegrationClaudeRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.uninstallClaude, request),
    installCodex: (request: AgentIntegrationCodexRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.installCodex, request),
    uninstallCodex: (request: AgentIntegrationCodexRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.uninstallCodex, request),
    onChange: (cb: (status: AgentIntegrationStatus) => void) =>
      subscribe<AgentIntegrationStatus>(IpcChannels.agentIntegration.changed, cb)
  },
  notify: {
    onToast: (cb: (toast: ToastNotification) => void) =>
      subscribe<ToastNotification>(IpcChannels.notify.toast, cb),
    onActivateSession: (cb: (sessionId: SessionId) => void) =>
      subscribe<SessionId>(IpcChannels.notify.activateSession, cb)
  },
  overview: {
    get: (request: GetOverviewRequest) =>
      ipcRenderer.invoke(IpcChannels.overview.get, request),
    regenerate: (request: RegenerateOverviewRequest) =>
      ipcRenderer.invoke(IpcChannels.overview.regenerate, request),
    askStart: (request: AskFollowUpRequest) =>
      ipcRenderer.invoke(IpcChannels.overview.askStart, request),
    askCancel: (requestId: string) =>
      ipcRenderer.invoke(IpcChannels.overview.askCancel, requestId),
    onChunk: (cb: (chunk: AskFollowUpChunk) => void) =>
      subscribe<AskFollowUpChunk>(IpcChannels.overview.askChunk, cb)
  },
  comments: {
    onRpcRequest: (cb: (request: CommentsRpcRequest) => void) =>
      subscribe<CommentsRpcRequest>(IpcChannels.comments.rpcRequest, cb),
    sendRpcResponse: (response: CommentsRpcResponse) =>
      ipcRenderer.send(IpcChannels.comments.rpcResponse, response)
  },
  diff: {
    onRpcRequest: (cb: (request: DiffRpcRequest) => void) =>
      subscribe<DiffRpcRequest>(IpcChannels.diff.rpcRequest, cb),
    sendRpcResponse: (response: DiffRpcResponse) =>
      ipcRenderer.send(IpcChannels.diff.rpcResponse, response)
  },
  features: {
    scan: (request: FeatureScanRequest) => ipcRenderer.invoke(IpcChannels.features.scan, request),
    setBranchStatus: (request: FeatureSetBranchStatusRequest) =>
      ipcRenderer.invoke(IpcChannels.features.setBranchStatus, request),
    setIssueStatus: (request: FeatureSetIssueStatusRequest) =>
      ipcRenderer.invoke(IpcChannels.features.setIssueStatus, request),
    subscribe: (request) => ipcRenderer.invoke(IpcChannels.features.subscribe, request),
    unsubscribe: (request) => ipcRenderer.invoke(IpcChannels.features.unsubscribe, request),
    onChange: (cb: (event: FeatureChangeEvent) => void) =>
      subscribe<FeatureChangeEvent>(IpcChannels.features.change, cb)
  },
  vault: {
    list: (request: VaultListRequest) => ipcRenderer.invoke(IpcChannels.vault.list, request),
    save: (request: VaultSaveRequest) => ipcRenderer.invoke(IpcChannels.vault.save, request),
    update: (request: VaultUpdateRequest) => ipcRenderer.invoke(IpcChannels.vault.update, request),
    delete: (request: VaultDeleteRequest) => ipcRenderer.invoke(IpcChannels.vault.delete, request),
    getSecret: (request: VaultGetSecretRequest) =>
      ipcRenderer.invoke(IpcChannels.vault.getSecret, request)
  },
  browser: {
    enableDeviceEmulation: (request: EnableDeviceEmulationRequest) =>
      ipcRenderer.invoke(IpcChannels.browser.enableDeviceEmulation, request),
    disableDeviceEmulation: (request: DisableDeviceEmulationRequest) =>
      ipcRenderer.invoke(IpcChannels.browser.disableDeviceEmulation, request),
    setUserAgent: (request: SetUserAgentRequest) =>
      ipcRenderer.invoke(IpcChannels.browser.setUserAgent, request),
    openDevTools: (request: OpenDevToolsRequest) =>
      ipcRenderer.invoke(IpcChannels.browser.openDevTools, request),
    setDevToolsLayout: (request: SetDevToolsLayoutRequest) =>
      ipcRenderer.invoke(IpcChannels.browser.setDevToolsLayout, request),
    closeDevTools: (request: CloseDevToolsRequest) =>
      ipcRenderer.invoke(IpcChannels.browser.closeDevTools, request)
  }
};

contextBridge.exposeInMainWorld('soloe', soloe);

// Ctrl+/-/0 inside a <webview> is consumed by Chromium's built-in zoom
// accelerator before the page (or our preload) can preventDefault it. The
// main process intercepts those keys at the webview's before-input-event
// and re-emits them on this channel; here we translate to the same window
// event the IDE chrome uses, so the rail's canvas-vs-page zoom router runs
// regardless of where focus is.
ipcRenderer.on(
  'soloe:webview-zoom-key',
  (_e: IpcRendererEvent, payload: { direction: 'in' | 'out' | 'reset' }) => {
    window.dispatchEvent(new CustomEvent('soloe:browser-zoom', { detail: { direction: payload.direction } }));
  }
);
