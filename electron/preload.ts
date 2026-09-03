import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  AgentIntegrationClaudeRequest,
  AgentIntegrationCodexRequest,
  AgentIntegrationCursorRequest,
  AgentIntegrationGrokRequest,
  AgentIntegrationOpenCodeRequest,
  AgentIntegrationAntigravityRequest,
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
import type {
  AddMachineConnectionRequest,
  ConnectionId,
  ConnectionSnapshot
} from '@shared/types/connections.js';
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
  ArtifactProjectRef,
  ArtifactsChangeEvent
} from '@shared/types/artifacts.js';
import type {
  FeatureChangeEvent,
  FeatureScanRequest,
  FeatureSetBranchStatusRequest,
  FeatureSetIssueStatusRequest
} from '@shared/types/features.js';
import type {
  VaultChangeEvent,
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
  GitCreateWorktreeRequest,
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
  DeviceImagePasteRequest,
  FileOpenRequest,
  FileReadRequest,
  FileTreeRequest,
  FileWriteRequest,
  ImagePasteRequest,
  FilePasteRequest,
  FileSearchRequest
} from '@shared/types/files.js';
import type { DiagnosticLogsRequest } from '@shared/types/diagnostics.js';
import type {
  ListSessionHookTraceRequest,
  SessionHookTraceEvent
} from '@shared/types/session-debug.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalInputLeaseEvent,
  TerminalControlProof,
  TerminalControllerIdentity,
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
import type {
  CreateMultiDeviceSessionRequest,
  MultiDeviceSessionState
} from '@shared/types/multi-device-sessions.js';
import type { DeviceEventEnvelope, SessionRef, TerminalRef } from '@shared/types/devices.js';

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
    deviceState: () => ipcRenderer.invoke(IpcChannels.sessions.deviceState),
    refreshDevices: () => ipcRenderer.invoke(IpcChannels.sessions.refreshDevices),
    reorderOnDevices: (refs: SessionRef[]) =>
      ipcRenderer.invoke(IpcChannels.sessions.reorderOnDevices, refs),
    createOnDevice: (request: CreateMultiDeviceSessionRequest) =>
      ipcRenderer.invoke(IpcChannels.sessions.createOnDevice, request),
    planCreateOnDevice: (request: CreateMultiDeviceSessionRequest) =>
      ipcRenderer.invoke(IpcChannels.sessions.planCreateOnDevice, request),
    executeCreateOnDevice: (planId: string) =>
      ipcRenderer.invoke(IpcChannels.sessions.executeCreateOnDevice, planId),
    browseDeviceWorkspaceDirectories: (request) =>
      ipcRenderer.invoke(IpcChannels.sessions.browseDeviceWorkspaceDirectories, request),
    modelCatalogOnDevice: (request) =>
      ipcRenderer.invoke(IpcChannels.sessions.modelCatalogOnDevice, request),
    openProjectOnDevice: (request) =>
      ipcRenderer.invoke(IpcChannels.sessions.openProjectOnDevice, request),
    updateProjectOnDevice: (request) =>
      ipcRenderer.invoke(IpcChannels.sessions.updateProjectOnDevice, request),
    deleteProjectOnDevice: (ref) =>
      ipcRenderer.invoke(IpcChannels.sessions.deleteProjectOnDevice, ref),
    executeDevicePreparation: (planId) =>
      ipcRenderer.invoke(IpcChannels.sessions.executeDevicePreparation, planId),
    startOnDevice: (ref: SessionRef) =>
      ipcRenderer.invoke(IpcChannels.sessions.startOnDevice, ref),
    updateOnDevice: (request) =>
      ipcRenderer.invoke(IpcChannels.sessions.updateOnDevice, request),
    deleteOnDevice: (ref: SessionRef) =>
      ipcRenderer.invoke(IpcChannels.sessions.deleteOnDevice, ref),
    previewCommandOnDevice: (ref: SessionRef) =>
      ipcRenderer.invoke(IpcChannels.sessions.previewCommandOnDevice, ref),
    ensureDeviceTailscalePort: (request) =>
      ipcRenderer.invoke(IpcChannels.sessions.ensureDeviceTailscalePort, request),
    listLocalhostBridges: () =>
      ipcRenderer.invoke(IpcChannels.sessions.listLocalhostBridges),
    openLocalhostBridge: (request) =>
      ipcRenderer.invoke(IpcChannels.sessions.openLocalhostBridge, request),
    closeLocalhostBridge: (port) =>
      ipcRenderer.invoke(IpcChannels.sessions.closeLocalhostBridge, port),
    setDeviceTerminalDemand: (refs: TerminalRef[]) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalDemand, refs),
    deviceTerminalInput: (request: { ref: TerminalRef; data: string; control: TerminalControlProof }) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalInput, request),
    deviceTerminalPasteImages: (request: DeviceImagePasteRequest) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalPasteImages, request),
    deviceTerminalInputLease: (request: { ref: TerminalRef; takeover?: boolean }) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalInputLease, request),
    deviceTerminalCurrentInputLease: (ref: TerminalRef) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalCurrentInputLease, ref),
    deviceTerminalReleaseInputLease: (request: {
      ref: TerminalRef;
      control: TerminalControlProof;
    }) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalReleaseInputLease, request),
    deviceTerminalParkInputLease: (request: {
      ref: TerminalRef;
      control: TerminalControlProof;
    }) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalParkInputLease, request),
    deviceTerminalResize: (request: {
      ref: TerminalRef;
      cols: number;
      rows: number;
      control: TerminalControlProof;
    }) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalResize, request),
    deviceTerminalHistory: (ref: TerminalRef) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalHistory, ref),
    deviceTerminalStop: (ref: TerminalRef) =>
      ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalStop, ref),
    invokeWorktree: (request) =>
      ipcRenderer.invoke(IpcChannels.sessions.invokeWorktree, request),
    onChange: (cb: (session: Session) => void) =>
      subscribe<Session>(IpcChannels.sessions.changed, cb),
    onDelete: (cb: (sessionId: SessionId) => void) =>
      subscribe<SessionId>(IpcChannels.sessions.deleted, cb),
    onDeviceStateChange: (cb: (state: MultiDeviceSessionState) => void) =>
      subscribe<MultiDeviceSessionState>(IpcChannels.sessions.deviceStateChanged, cb),
    onDeviceEvent: (cb: (event: DeviceEventEnvelope) => void) =>
      subscribe<DeviceEventEnvelope>(IpcChannels.sessions.deviceEvent, cb)
  },
  terminal: {
    start: (opts: TerminalStartOptions) => ipcRenderer.invoke(IpcChannels.terminal.start, opts),
    stop: (terminalId: TerminalId) => ipcRenderer.invoke(IpcChannels.terminal.stop, terminalId),
    restart: (sessionId: SessionId, opts) =>
      ipcRenderer.invoke(IpcChannels.terminal.restart, sessionId, opts),
    acquireInputLease: (
      terminalId: TerminalId,
      controller: TerminalControllerIdentity,
      takeover = false
    ) => ipcRenderer.invoke(
      IpcChannels.terminal.acquireInputLease,
      terminalId,
      controller,
      takeover
    ),
    currentInputLease: (terminalId: TerminalId) =>
      ipcRenderer.invoke(IpcChannels.terminal.currentInputLease, terminalId),
    releaseInputLease: (terminalId: TerminalId, control: TerminalControlProof) =>
      ipcRenderer.invoke(IpcChannels.terminal.releaseInputLease, terminalId, control),
    parkInputLease: (terminalId: TerminalId, control: TerminalControlProof) =>
      ipcRenderer.invoke(IpcChannels.terminal.parkInputLease, terminalId, control),
    input: (payload: TerminalInputPayload) => ipcRenderer.invoke(IpcChannels.terminal.input, payload),
    resize: (payload: TerminalResizePayload) =>
      ipcRenderer.invoke(IpcChannels.terminal.resize, payload),
    listRunning: () => ipcRenderer.invoke(IpcChannels.terminal.listRunning),
    historySnapshot: (terminalId: TerminalId) =>
      ipcRenderer.invoke(IpcChannels.terminal.historySnapshot, terminalId),
    setOutputDemand: (payload: TerminalOutputDemandPayload) =>
      ipcRenderer.invoke(IpcChannels.terminal.outputDemand, payload),
    onOutput: (cb: (event: TerminalOutputEvent) => void) =>
      subscribe<TerminalOutputEvent>(IpcChannels.terminal.output, cb),
    onExit: (cb: (event: TerminalExitEvent) => void) =>
      subscribe<TerminalExitEvent>(IpcChannels.terminal.exit, cb),
    onStatus: (cb: (event: TerminalStatusEvent) => void) =>
      subscribe<TerminalStatusEvent>(IpcChannels.terminal.status, cb),
    onLocation: (cb: (event: TerminalLocationEvent) => void) =>
      subscribe<TerminalLocationEvent>(IpcChannels.terminal.location, cb),
    onInputLease: (cb: (event: TerminalInputLeaseEvent) => void) =>
      subscribe<TerminalInputLeaseEvent>(IpcChannels.terminal.inputLease, cb)
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
    modelCatalog: () => ipcRenderer.invoke(IpcChannels.settings.modelCatalog),
    onChange: (cb: (settings: Settings) => void) =>
      subscribe<Settings>(IpcChannels.settings.change, cb)
  },
  connections: {
    get: () => ipcRenderer.invoke(IpcChannels.connections.get),
    refresh: () => ipcRenderer.invoke(IpcChannels.connections.refresh),
    configure: (patch) => ipcRenderer.invoke(IpcChannels.connections.configure, patch),
    setupShortDns: (targetId) => ipcRenderer.invoke(IpcChannels.connections.setupShortDns, targetId),
    removeShortDns: (targetId) => ipcRenderer.invoke(IpcChannels.connections.removeShortDns, targetId),
    add: (request: AddMachineConnectionRequest) =>
      ipcRenderer.invoke(IpcChannels.connections.add, request),
    remove: (id: ConnectionId) => ipcRenderer.invoke(IpcChannels.connections.remove, id),
    setEnabled: (id: ConnectionId, enabled: boolean) =>
      ipcRenderer.invoke(IpcChannels.connections.enable, id, enabled),
    select: (id: ConnectionId) => ipcRenderer.invoke(IpcChannels.connections.select, id),
    onChange: (cb: (snapshot: ConnectionSnapshot) => void) =>
      subscribe<ConnectionSnapshot>(IpcChannels.connections.change, cb)
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
    write: (
      projectId: ProjectId,
      filename: string,
      content: string,
      expectedRevision?: string | null
    ) =>
      ipcRenderer.invoke(
        IpcChannels.notes.write,
        projectId,
        filename,
        content,
        expectedRevision
      ),
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
  artifacts: {
    list: (project: ArtifactProjectRef) =>
      ipcRenderer.invoke(IpcChannels.artifacts.list, project),
    read: (project: ArtifactProjectRef, artifactId: string) =>
      ipcRenderer.invoke(IpcChannels.artifacts.read, project, artifactId),
    prepareFrame: (html: string) =>
      ipcRenderer.invoke(IpcChannels.artifacts.prepareFrame, html),
    delete: (project: ArtifactProjectRef, artifactId: string) =>
      ipcRenderer.invoke(IpcChannels.artifacts.delete, project, artifactId),
    onChange: (cb: (event: ArtifactsChangeEvent) => void) =>
      subscribe<ArtifactsChangeEvent>(IpcChannels.artifacts.change, cb)
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
    createWorktree: (request: GitCreateWorktreeRequest) =>
      ipcRenderer.invoke(IpcChannels.git.createWorktree, request),
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
    crashLogs: (request?: DiagnosticLogsRequest) =>
      ipcRenderer.invoke(IpcChannels.diagnostics.crashLogs, request),
    sessionHookTrace: (request?: ListSessionHookTraceRequest) =>
      ipcRenderer.invoke(IpcChannels.diagnostics.sessionHookTrace, request),
    clearSessionHookTrace: () =>
      ipcRenderer.invoke(IpcChannels.diagnostics.clearSessionHookTrace),
    onSessionHookEvent: (cb: (event: SessionHookTraceEvent) => void) =>
      subscribe<SessionHookTraceEvent>(IpcChannels.diagnostics.sessionHookEvent, cb)
  },
  window: {
    minimize: () => ipcRenderer.invoke(IpcChannels.window.minimize),
    toggleMaximize: () => ipcRenderer.invoke(IpcChannels.window.toggleMaximize),
    zoomIn: () => ipcRenderer.invoke(IpcChannels.window.zoomIn),
    zoomOut: () => ipcRenderer.invoke(IpcChannels.window.zoomOut),
    openSessionEventsDebug: () => ipcRenderer.invoke(IpcChannels.window.openSessionEventsDebug),
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
    installCursor: (request: AgentIntegrationCursorRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.installCursor, request),
    uninstallCursor: (request: AgentIntegrationCursorRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.uninstallCursor, request),
    installOpenCode: (request: AgentIntegrationOpenCodeRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.installOpenCode, request),
    uninstallOpenCode: (request: AgentIntegrationOpenCodeRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.uninstallOpenCode, request),
    installGrok: (request: AgentIntegrationGrokRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.installGrok, request),
    uninstallGrok: (request: AgentIntegrationGrokRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.uninstallGrok, request),
    installAntigravity: (request: AgentIntegrationAntigravityRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.installAntigravity, request),
    uninstallAntigravity: (request: AgentIntegrationAntigravityRequest) =>
      ipcRenderer.invoke(IpcChannels.agentIntegration.uninstallAntigravity, request),
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
      ipcRenderer.invoke(IpcChannels.vault.getSecret, request),
    onChange: (cb: (event: VaultChangeEvent) => void) =>
      subscribe<VaultChangeEvent>(IpcChannels.vault.change, cb)
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
  },
  browserSessions: {
    get: () => ipcRenderer.invoke(IpcChannels.browserSessions.get),
    update: (request) => ipcRenderer.invoke(IpcChannels.browserSessions.update, request)
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

ipcRenderer.on('soloe:webview-toggle-devtools', () => {
  window.dispatchEvent(new CustomEvent('soloe:browser-toggle-devtools'));
});

ipcRenderer.on('soloe:webview-restore-tab', () => {
  window.dispatchEvent(new CustomEvent('soloe:browser-restore-tab'));
});
