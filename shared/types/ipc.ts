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
  CommitsBetweenRequest,
  CommitsBetweenResult,
  FileBlameRequest,
  FileBlameResult,
  FileDiff,
  FileDiffRequest,
  FileLinesRequest,
  FileLinesResult,
  GitAheadBehind,
  GitBranch,
  GitCheckoutRequest,
  GitCreateWorktreeRequest,
  GitChangeEvent,
  GitCommit,
  GitDirty,
  GitHistoryCommit,
  GitObservationDemandRequest,
  GitRefHistoryRequest,
  GitRecentCommitsRequest,
  GitRepoRequest,
  GitShortstat,
  GitStatus,
  GitStatusRequest,
  GitWorktree,
  RangeChangesRequest,
  RangeChangesResult,
  ReviewDiffsRequest,
  ResolveRefsRequest,
  ResolveRefsResult,
  StageFilesRequest,
  DiscardFilesRequest,
  WorkingChangesRequest,
  WorkingChangesResult,
  WorkingTreeSnapshotRequest,
  WorkingTreeSnapshot,
  GitCommitRequest,
  GitCommitResult,
  GitRemoteOpRequest,
  GitRemoteOpResult
} from './git.js';
import type {
  DeviceImagePasteRequest,
  FileOpenRequest,
  FileReadRequest,
  FileReadResult,
  FileTreeRequest,
  FileTreeResult,
  FileWriteRequest,
  ImagePasteRequest,
  ImagePasteResult,
  FilePasteRequest,
  FileSearchRequest,
  FileSearchResult
} from './files.js';
import type {
  CrashLogSummary,
  DiagnosticItem,
  DiagnosticLogsRequest
} from './diagnostics.js';
import type {
  ListSessionHookTraceRequest,
  SessionHookTraceEvent
} from './session-debug.js';
import type {
  CoverageMapSnapshot,
  FeatureChangeEvent,
  FeatureIssueEntry,
  FeatureScanRequest,
  FeatureSetBranchStatusRequest,
  FeatureSetIssueStatusRequest,
  FeatureSnapshot
} from './features.js';
import type {
  Project,
  ProjectDetectResult,
  ProjectDraft,
  ProjectFavicon,
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
import type { ModelCatalogEntry, Settings, SettingsUpdate } from './settings.js';
import type { CommentsRpcRequest, CommentsRpcResponse } from './comments-rpc.js';
import type { DiffRpcRequest, DiffRpcResponse } from './diff-rpc.js';
import type {
  NoteContent,
  NoteImage,
  NoteImageData,
  NoteSummary,
  NotesChangeEvent
} from './notes.js';
import type {
  ArtifactCatalogSnapshot,
  ArtifactDeleteResult,
  ArtifactDocument,
  ArtifactProjectRef,
  ArtifactsChangeEvent
} from './artifacts.js';
import type {
  SpawnSpec,
  TerminalDimensions,
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalInputLease,
  TerminalInputLeaseEvent,
  TerminalControlProof,
  TerminalControllerIdentity,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStartResult,
  TerminalStatusEvent
} from './terminal.js';
import type { HostPlatformInfo, SystemUsageRequest, SystemUsageSnapshot } from './system.js';
import type {
  VaultChangeEvent,
  VaultDeleteRequest,
  VaultEntry,
  VaultGetSecretRequest,
  VaultListRequest,
  VaultSaveRequest,
  VaultSecret,
  VaultUpdateRequest
} from './vault.js';
import type {
  CloseDevToolsRequest,
  DisableDeviceEmulationRequest,
  EnableDeviceEmulationRequest,
  OpenDevToolsRequest,
  SetDevToolsLayoutRequest,
  SetUserAgentRequest
} from './browser.js';
import type {
  BrowserSessionSnapshot,
  BrowserSessionUpdateRequest
} from './browser-sessions.js';
import type {
  AddMachineConnectionRequest,
  ConnectionId,
  ConnectionSelectionResult,
  ConnectionSnapshot
} from './connections.js';
import type {
  DeviceEventEnvelope,
  DeviceId,
  DevicePortForwardResult,
  ProjectRef,
  SessionRef,
  TerminalRef
} from './devices.js';
import type {
  CreateMultiDeviceSessionRequest,
  DeviceWorktreeInvokeRequest,
  DeviceTerminalHistory,
  MultiDeviceSessionCreationPlan,
  MultiDeviceSessionState,
  MultiDeviceSessionView
} from './multi-device-sessions.js';

export const IpcChannels = {
  sessions: {
    list: 'sessions:list',
    listArchived: 'sessions:list-archived',
    get: 'sessions:get',
    create: 'sessions:create',
    update: 'sessions:update',
    delete: 'sessions:delete',
    reorder: 'sessions:reorder',
    previewCommand: 'sessions:preview-command',
    deviceState: 'sessions:device-state',
    refreshDevices: 'sessions:refresh-devices',
    reorderOnDevices: 'sessions:reorder-on-devices',
    createOnDevice: 'sessions:create-on-device',
    planCreateOnDevice: 'sessions:plan-create-on-device',
    executeCreateOnDevice: 'sessions:execute-create-on-device',
    browseDeviceWorkspaceDirectories: 'sessions:browse-device-workspace-directories',
    openProjectOnDevice: 'sessions:open-project-on-device',
    updateProjectOnDevice: 'sessions:update-project-on-device',
    deleteProjectOnDevice: 'sessions:delete-project-on-device',
    executeDevicePreparation: 'sessions:execute-device-preparation',
    startOnDevice: 'sessions:start-on-device',
    updateOnDevice: 'sessions:update-on-device',
    deleteOnDevice: 'sessions:delete-on-device',
    previewCommandOnDevice: 'sessions:preview-command-on-device',
    ensureDeviceTailscalePort: 'sessions:ensure-device-tailscale-port',
    deviceTerminalDemand: 'sessions:device-terminal-demand',
    deviceTerminalInput: 'sessions:device-terminal-input',
    deviceTerminalPasteImages: 'sessions:device-terminal-paste-images',
    deviceTerminalInputLease: 'sessions:device-terminal-input-lease',
    deviceTerminalCurrentInputLease: 'sessions:device-terminal-current-input-lease',
    deviceTerminalReleaseInputLease: 'sessions:device-terminal-release-input-lease',
    deviceTerminalParkInputLease: 'sessions:device-terminal-park-input-lease',
    deviceTerminalResize: 'sessions:device-terminal-resize',
    deviceTerminalHistory: 'sessions:device-terminal-history',
    deviceTerminalStop: 'sessions:device-terminal-stop',
    invokeWorktree: 'sessions:invoke-worktree',
    changed: 'sessions:changed',
    deleted: 'sessions:deleted',
    deviceStateChanged: 'sessions:device-state-changed',
    deviceEvent: 'sessions:device-event'
  },
  terminal: {
    start: 'terminal:start',
    stop: 'terminal:stop',
    restart: 'terminal:restart',
    acquireInputLease: 'terminal:acquire-input-lease',
    currentInputLease: 'terminal:current-input-lease',
    releaseInputLease: 'terminal:release-input-lease',
    parkInputLease: 'terminal:park-input-lease',
    input: 'terminal:input',
    resize: 'terminal:resize',
    listRunning: 'terminal:list-running',
    historySnapshot: 'terminal:history-snapshot',
    outputDemand: 'terminal:output-demand',
    output: 'terminal:output',
    exit: 'terminal:exit',
    status: 'terminal:status',
    location: 'terminal:location',
    inputLease: 'terminal:input-lease'
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
    platform: 'system:platform',
    openPath: 'system:open-path',
    saveText: 'system:save-text',
    openExternal: 'system:open-external',
    listWslDistros: 'system:list-wsl-distros',
    usage: 'system:usage'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    modelCatalog: 'settings:model-catalog',
    change: 'settings:change'
  },
  connections: {
    get: 'connections:get',
    refresh: 'connections:refresh',
    configure: 'connections:configure',
    setupShortDns: 'connections:setup-short-dns',
    removeShortDns: 'connections:remove-short-dns',
    add: 'connections:add',
    remove: 'connections:remove',
    enable: 'connections:enable',
    select: 'connections:select',
    change: 'connections:change'
  },
  projects: {
    list: 'projects:list',
    get: 'projects:get',
    create: 'projects:create',
    open: 'projects:open',
    update: 'projects:update',
    delete: 'projects:delete',
    touch: 'projects:touch',
    reorder: 'projects:reorder',
    refreshFavicons: 'projects:refresh-favicons',
    readFavicon: 'projects:read-favicon',
    detectFromPath: 'projects:detect-from-path',
    suggestPaths: 'projects:suggest-paths',
    change: 'projects:change'
  },
  notes: {
    list: 'notes:list',
    read: 'notes:read',
    write: 'notes:write',
    rename: 'notes:rename',
    delete: 'notes:delete',
    saveImage: 'notes:save-image',
    readImage: 'notes:read-image',
    cleanupImages: 'notes:cleanup-images',
    change: 'notes:change'
  },
  artifacts: {
    list: 'artifacts:list',
    read: 'artifacts:read',
    delete: 'artifacts:delete',
    change: 'artifacts:change'
  },
  git: {
    status: 'git:status',
    aheadBehind: 'git:ahead-behind',
    shortstat: 'git:shortstat',
    dirty: 'git:dirty',
    worktrees: 'git:worktrees',
    branches: 'git:branches',
    recentCommits: 'git:recent-commits',
    refHistory: 'git:ref-history',
    commitsBetween: 'git:commits-between',
    rangeChanges: 'git:range-changes',
    resolveRefs: 'git:resolve-refs',
    checkout: 'git:checkout',
    createWorktree: 'git:create-worktree',
    workingChanges: 'git:working-changes',
    workingTreeSnapshot: 'git:working-tree-snapshot',
    observationDemand: 'git:observation-demand',
    fileDiff: 'git:file-diff',
    reviewDiffs: 'git:review-diffs',
    fileBlame: 'git:file-blame',
    fileLines: 'git:file-lines',
    stageFiles: 'git:stage-files',
    unstageFiles: 'git:unstage-files',
    discardFiles: 'git:discard-files',
    commit: 'git:commit',
    push: 'git:push',
    pull: 'git:pull',
    fetch: 'git:fetch',
    change: 'git:change'
  },
  files: {
    search: 'files:search',
    openInEditor: 'files:open-in-editor',
    pasteIntoTerminal: 'files:paste-into-terminal',
    pasteImagesIntoTerminal: 'files:paste-images-into-terminal',
    listTree: 'files:list-tree',
    readFile: 'files:read-file',
    writeFile: 'files:write-file'
  },
  diagnostics: {
    list: 'diagnostics:list',
    crashLogs: 'diagnostics:crash-logs',
    sessionHookTrace: 'diagnostics:session-hook-trace',
    clearSessionHookTrace: 'diagnostics:clear-session-hook-trace',
    sessionHookEvent: 'diagnostics:session-hook-event'
  },
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggle-maximize',
    zoomIn: 'window:zoom-in',
    zoomOut: 'window:zoom-out',
    openSessionEventsDebug: 'window:open-session-events-debug',
    close: 'window:close'
  },
  agentIntegration: {
    status: 'agent-integration:status',
    installClaude: 'agent-integration:install-claude',
    uninstallClaude: 'agent-integration:uninstall-claude',
    installCodex: 'agent-integration:install-codex',
    uninstallCodex: 'agent-integration:uninstall-codex',
    installCursor: 'agent-integration:install-cursor',
    uninstallCursor: 'agent-integration:uninstall-cursor',
    installOpenCode: 'agent-integration:install-opencode',
    uninstallOpenCode: 'agent-integration:uninstall-opencode',
    installGrok: 'agent-integration:install-grok',
    uninstallGrok: 'agent-integration:uninstall-grok',
    changed: 'agent-integration:changed'
  },
  notify: {
    toast: 'notify:toast',
    activateSession: 'notify:activate-session'
  },
  overview: {
    get: 'overview:get',
    regenerate: 'overview:regenerate',
    askStart: 'overview:ask-start',
    askCancel: 'overview:ask-cancel',
    askChunk: 'overview:ask-chunk'
  },
  comments: {
    rpcRequest: 'comments:rpc:request',
    rpcResponse: 'comments:rpc:response'
  },
  diff: {
    rpcRequest: 'diff:rpc:request',
    rpcResponse: 'diff:rpc:response'
  },
  features: {
    scan: 'features:scan',
    setBranchStatus: 'features:set-branch-status',
    setIssueStatus: 'features:set-issue-status',
    subscribe: 'features:subscribe',
    unsubscribe: 'features:unsubscribe',
    change: 'features:change'
  },
  vault: {
    list: 'vault:list',
    save: 'vault:save',
    update: 'vault:update',
    delete: 'vault:delete',
    getSecret: 'vault:get-secret',
    change: 'vault:change'
  },
  browser: {
    enableDeviceEmulation: 'browser:enable-device-emulation',
    disableDeviceEmulation: 'browser:disable-device-emulation',
    setUserAgent: 'browser:set-user-agent',
    openDevTools: 'browser:open-devtools',
    setDevToolsLayout: 'browser:set-devtools-layout',
    closeDevTools: 'browser:close-devtools'
  },
  browserSessions: {
    get: 'browser-sessions:get',
    update: 'browser-sessions:update'
  }
} as const;

export type IpcChannel =
  | (typeof IpcChannels.sessions)[keyof typeof IpcChannels.sessions]
  | (typeof IpcChannels.terminal)[keyof typeof IpcChannels.terminal]
  | (typeof IpcChannels.observer)[keyof typeof IpcChannels.observer]
  | (typeof IpcChannels.system)[keyof typeof IpcChannels.system]
  | (typeof IpcChannels.settings)[keyof typeof IpcChannels.settings]
  | (typeof IpcChannels.connections)[keyof typeof IpcChannels.connections]
  | (typeof IpcChannels.projects)[keyof typeof IpcChannels.projects]
  | (typeof IpcChannels.notes)[keyof typeof IpcChannels.notes]
  | (typeof IpcChannels.git)[keyof typeof IpcChannels.git]
  | (typeof IpcChannels.files)[keyof typeof IpcChannels.files]
  | (typeof IpcChannels.diagnostics)[keyof typeof IpcChannels.diagnostics]
  | (typeof IpcChannels.window)[keyof typeof IpcChannels.window]
  | (typeof IpcChannels.agentIntegration)[keyof typeof IpcChannels.agentIntegration]
  | (typeof IpcChannels.notify)[keyof typeof IpcChannels.notify]
  | (typeof IpcChannels.overview)[keyof typeof IpcChannels.overview]
  | (typeof IpcChannels.comments)[keyof typeof IpcChannels.comments]
  | (typeof IpcChannels.diff)[keyof typeof IpcChannels.diff]
  | (typeof IpcChannels.features)[keyof typeof IpcChannels.features]
  | (typeof IpcChannels.vault)[keyof typeof IpcChannels.vault]
  | (typeof IpcChannels.browser)[keyof typeof IpcChannels.browser]
  | (typeof IpcChannels.browserSessions)[keyof typeof IpcChannels.browserSessions];

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string; remediation?: string };

export interface SessionsApi {
  list(): Promise<IpcResult<Session[]>>;
  listArchived(): Promise<IpcResult<Session[]>>;
  get(id: SessionId): Promise<IpcResult<Session | null>>;
  create(draft: SessionDraft): Promise<IpcResult<Session>>;
  update(id: SessionId, patch: SessionUpdate): Promise<IpcResult<Session>>;
  delete(id: SessionId): Promise<IpcResult<true>>;
  reorder(orderedIds: SessionId[]): Promise<IpcResult<Session[]>>;
  previewCommand(id: SessionId): Promise<IpcResult<SpawnSpec>>;
  deviceState?(): Promise<IpcResult<MultiDeviceSessionState>>;
  refreshDevices?(): Promise<IpcResult<MultiDeviceSessionState>>;
  reorderOnDevices?(orderedRefs: SessionRef[]): Promise<IpcResult<MultiDeviceSessionState>>;
  createOnDevice?(
    request: CreateMultiDeviceSessionRequest
  ): Promise<IpcResult<MultiDeviceSessionView>>;
  planCreateOnDevice?(
    request: CreateMultiDeviceSessionRequest
  ): Promise<IpcResult<MultiDeviceSessionCreationPlan>>;
  executeCreateOnDevice?(planId: string): Promise<IpcResult<MultiDeviceSessionView>>;
  browseDeviceWorkspaceDirectories?(
    request: import('./multi-device-sessions.js').BrowseDeviceWorkspaceDirectoriesRequest
  ): Promise<IpcResult<import('./workspaces.js').WorkspaceDirectoryListing>>;
  openProjectOnDevice?(
    request: { deviceId: import('./devices.js').DeviceId; project: ProjectOpenRequest }
  ): Promise<IpcResult<MultiDeviceSessionState>>;
  updateProjectOnDevice?(
    request: { ref: ProjectRef; patch: ProjectUpdate }
  ): Promise<IpcResult<MultiDeviceSessionState>>;
  deleteProjectOnDevice?(ref: ProjectRef): Promise<IpcResult<MultiDeviceSessionState>>;
  executeDevicePreparation?(planId: string): Promise<IpcResult<MultiDeviceSessionState>>;
  startOnDevice?(ref: SessionRef): Promise<IpcResult<MultiDeviceSessionView>>;
  updateOnDevice?(
    request: { ref: SessionRef; patch: SessionUpdate }
  ): Promise<IpcResult<MultiDeviceSessionView>>;
  deleteOnDevice?(ref: SessionRef): Promise<IpcResult<MultiDeviceSessionState>>;
  previewCommandOnDevice?(ref: SessionRef): Promise<IpcResult<SpawnSpec>>;
  ensureDeviceTailscalePort?(
    request: { deviceId: DeviceId; port: number; virtualHostname?: string }
  ): Promise<IpcResult<DevicePortForwardResult>>;
  setDeviceTerminalDemand?(refs: TerminalRef[]): Promise<IpcResult<true>>;
  deviceTerminalInput?(
    request: { ref: TerminalRef; data: string; control: TerminalControlProof }
  ): Promise<IpcResult<true>>;
  deviceTerminalPasteImages?(
    request: DeviceImagePasteRequest
  ): Promise<IpcResult<ImagePasteResult>>;
  deviceTerminalInputLease?(
    request: { ref: TerminalRef; takeover?: boolean }
  ): Promise<IpcResult<TerminalInputLease>>;
  deviceTerminalCurrentInputLease?(ref: TerminalRef): Promise<IpcResult<TerminalInputLease | null>>;
  deviceTerminalReleaseInputLease?(
    request: { ref: TerminalRef; control: TerminalControlProof }
  ): Promise<IpcResult<boolean>>;
  deviceTerminalParkInputLease?(
    request: { ref: TerminalRef; control: TerminalControlProof }
  ): Promise<IpcResult<boolean>>;
  deviceTerminalResize?(
    request: { ref: TerminalRef; cols: number; rows: number; control: TerminalControlProof }
  ): Promise<IpcResult<true>>;
  deviceTerminalHistory?(ref: TerminalRef): Promise<IpcResult<DeviceTerminalHistory>>;
  deviceTerminalStop?(ref: TerminalRef): Promise<IpcResult<true>>;
  invokeWorktree?(request: DeviceWorktreeInvokeRequest): Promise<IpcResult<unknown>>;

  onChange(listener: (session: Session) => void): () => void;
  onDelete(listener: (sessionId: SessionId) => void): () => void;
  onDeviceStateChange?(
    listener: (state: MultiDeviceSessionState) => void
  ): () => void;
  onDeviceEvent?(listener: (event: DeviceEventEnvelope) => void): () => void;
}

export interface TerminalInputPayload {
  terminalId: TerminalId;
  data: string;
  control: TerminalControlProof;
}

export interface TerminalResizePayload {
  terminalId: TerminalId;
  dimensions: TerminalDimensions;
  control: TerminalControlProof;
}

export interface TerminalOutputDemandPayload {
  terminalId: TerminalId;
  active: boolean;
}

export interface TerminalApi {
  start(opts: TerminalStartOptions): Promise<IpcResult<TerminalStartResult>>;
  stop(terminalId: TerminalId): Promise<IpcResult<true>>;
  restart(sessionId: SessionId, opts?: { cols?: number; rows?: number }): Promise<IpcResult<TerminalStartResult>>;
  acquireInputLease(
    terminalId: TerminalId,
    controller: TerminalControllerIdentity,
    takeover?: boolean
  ): Promise<IpcResult<TerminalInputLease>>;
  currentInputLease(terminalId: TerminalId): Promise<IpcResult<TerminalInputLease | null>>;
  releaseInputLease(
    terminalId: TerminalId,
    control: TerminalControlProof
  ): Promise<IpcResult<boolean>>;
  parkInputLease(
    terminalId: TerminalId,
    control: TerminalControlProof
  ): Promise<IpcResult<boolean>>;
  input(payload: TerminalInputPayload): Promise<IpcResult<true>>;
  resize(payload: TerminalResizePayload): Promise<IpcResult<true>>;
  listRunning(): Promise<IpcResult<SessionRuntimeState[]>>;
  historySnapshot(
    terminalId: TerminalId
  ): Promise<IpcResult<import('./terminal.js').TerminalHistorySnapshot | null>>;
  setOutputDemand(payload: TerminalOutputDemandPayload): Promise<IpcResult<true>>;

  onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  onStatus(listener: (event: TerminalStatusEvent) => void): () => void;
  onLocation(listener: (event: TerminalLocationEvent) => void): () => void;
  onInputLease(listener: (event: TerminalInputLeaseEvent) => void): () => void;
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
  platform(): Promise<IpcResult<HostPlatformInfo>>;
  openPath(sessionId: SessionId): Promise<IpcResult<true>>;
  saveText(request: { defaultPath?: string; content: string }): Promise<IpcResult<true>>;
  openExternal(url: string): Promise<IpcResult<true>>;
  listWslDistros(): Promise<IpcResult<string[]>>;
  usage(request?: SystemUsageRequest): Promise<IpcResult<SystemUsageSnapshot>>;
}

export interface SettingsApi {
  get(): Promise<IpcResult<Settings>>;
  update(patch: SettingsUpdate): Promise<IpcResult<Settings>>;
  modelCatalog(): Promise<IpcResult<ModelCatalogEntry[]>>;
  onChange(listener: (settings: Settings) => void): () => void;
}

export interface ConnectionsApi {
  get(): Promise<IpcResult<ConnectionSnapshot>>;
  refresh(): Promise<IpcResult<ConnectionSnapshot>>;
  configure(patch: import('./connections.js').ConnectionPreferencesUpdate): Promise<IpcResult<ConnectionSnapshot>>;
  setupShortDns?(targetId?: ConnectionId): Promise<IpcResult<ConnectionSnapshot>>;
  removeShortDns?(targetId?: ConnectionId): Promise<IpcResult<ConnectionSnapshot>>;
  add(request: AddMachineConnectionRequest): Promise<IpcResult<ConnectionSnapshot>>;
  remove(id: ConnectionId): Promise<IpcResult<ConnectionSnapshot>>;
  setEnabled(id: ConnectionId, enabled: boolean): Promise<IpcResult<ConnectionSnapshot>>;
  select(id: ConnectionId): Promise<IpcResult<ConnectionSelectionResult>>;
  onChange(cb: (snapshot: ConnectionSnapshot) => void): () => void;
}

export interface ProjectsApi {
  list(): Promise<IpcResult<Project[]>>;
  get(id: ProjectId): Promise<IpcResult<Project | null>>;
  create(draft: ProjectDraft): Promise<IpcResult<Project>>;
  open(request: ProjectOpenRequest): Promise<IpcResult<Project>>;
  update(id: ProjectId, patch: ProjectUpdate): Promise<IpcResult<Project>>;
  delete(id: ProjectId): Promise<IpcResult<true>>;
  touch(id: ProjectId): Promise<IpcResult<Project | null>>;
  reorder(orderedIds: ProjectId[]): Promise<IpcResult<Project[]>>;
  refreshFavicons(id: ProjectId): Promise<IpcResult<ProjectFavicon[]>>;
  readFavicon(id: ProjectId, relativePath: string): Promise<IpcResult<ProjectFavicon | null>>;
  detectFromPath(path: string): Promise<IpcResult<ProjectDetectResult>>;
  suggestPaths(
    query: string,
    options?: ProjectSuggestOptions
  ): Promise<IpcResult<ProjectSuggestResult>>;
  onChange(listener: (projects: Project[]) => void): () => void;
}

export interface NotesApi {
  list(projectId: ProjectId): Promise<IpcResult<NoteSummary[]>>;
  read(projectId: ProjectId, filename: string): Promise<IpcResult<NoteContent>>;
  write(
    projectId: ProjectId,
    filename: string,
    content: string,
    expectedRevision?: string | null
  ): Promise<IpcResult<NoteContent>>;
  rename(
    projectId: ProjectId,
    oldName: string,
    newName: string
  ): Promise<IpcResult<NoteSummary>>;
  delete(projectId: ProjectId, filename: string): Promise<IpcResult<true>>;
  saveImage(
    projectId: ProjectId,
    mimeType: string,
    dataBase64: string
  ): Promise<IpcResult<NoteImage>>;
  readImage(absolutePath: string): Promise<IpcResult<NoteImageData>>;
  cleanupImages(
    projectId: ProjectId,
    extraReferences: string[]
  ): Promise<IpcResult<{ deleted: number }>>;
  onChange(listener: (event: NotesChangeEvent) => void): () => void;
}

export interface ArtifactsApi {
  list(project: ArtifactProjectRef): Promise<IpcResult<ArtifactCatalogSnapshot>>;
  read(project: ArtifactProjectRef, artifactId: string): Promise<IpcResult<ArtifactDocument>>;
  delete(
    project: ArtifactProjectRef,
    artifactId: string
  ): Promise<IpcResult<ArtifactDeleteResult>>;
  onChange(listener: (event: ArtifactsChangeEvent) => void): () => void;
}

export interface GitApi {
  status(request: GitStatusRequest): Promise<IpcResult<GitStatus>>;
  aheadBehind(request: GitRepoRequest): Promise<IpcResult<GitAheadBehind>>;
  shortstat(request: GitRepoRequest): Promise<IpcResult<GitShortstat>>;
  dirty(request: GitRepoRequest): Promise<IpcResult<GitDirty>>;
  worktrees(request: GitRepoRequest): Promise<IpcResult<GitWorktree[]>>;
  branches(request: GitRepoRequest): Promise<IpcResult<GitBranch[]>>;
  recentCommits(request: GitRecentCommitsRequest): Promise<IpcResult<GitCommit[]>>;
  refHistory(request: GitRefHistoryRequest): Promise<IpcResult<GitHistoryCommit[]>>;
  commitsBetween(request: CommitsBetweenRequest): Promise<IpcResult<CommitsBetweenResult>>;
  rangeChanges(request: RangeChangesRequest): Promise<IpcResult<RangeChangesResult>>;
  resolveRefs(request: ResolveRefsRequest): Promise<IpcResult<ResolveRefsResult>>;
  checkout(request: GitCheckoutRequest): Promise<IpcResult<GitStatus>>;
  createWorktree(request: GitCreateWorktreeRequest): Promise<IpcResult<GitWorktree>>;
  workingChanges(request: WorkingChangesRequest): Promise<IpcResult<WorkingChangesResult>>;
  workingTreeSnapshot(
    request: WorkingTreeSnapshotRequest
  ): Promise<IpcResult<WorkingTreeSnapshot>>;
  setObservationDemand(request: GitObservationDemandRequest): Promise<IpcResult<true>>;
  fileDiff(request: FileDiffRequest): Promise<IpcResult<FileDiff>>;
  reviewDiffs(request: ReviewDiffsRequest): Promise<IpcResult<FileDiff[]>>;
  fileBlame(request: FileBlameRequest): Promise<IpcResult<FileBlameResult>>;
  fileLines(request: FileLinesRequest): Promise<IpcResult<FileLinesResult>>;
  stageFiles(request: StageFilesRequest): Promise<IpcResult<true>>;
  unstageFiles(request: StageFilesRequest): Promise<IpcResult<true>>;
  discardFiles(request: DiscardFilesRequest): Promise<IpcResult<true>>;
  commit(request: GitCommitRequest): Promise<IpcResult<GitCommitResult>>;
  push(request: GitRemoteOpRequest): Promise<IpcResult<GitRemoteOpResult>>;
  pull(request: GitRemoteOpRequest): Promise<IpcResult<GitRemoteOpResult>>;
  fetch(request: GitRemoteOpRequest): Promise<IpcResult<GitRemoteOpResult>>;
  onChange(listener: (event: GitChangeEvent) => void): () => void;
}

export interface FilesApi {
  search(request: FileSearchRequest): Promise<IpcResult<FileSearchResult[]>>;
  openInEditor(request: FileOpenRequest): Promise<IpcResult<true>>;
  pasteIntoTerminal(request: FilePasteRequest): Promise<IpcResult<true>>;
  pasteImagesIntoTerminal(request: ImagePasteRequest): Promise<IpcResult<ImagePasteResult>>;
  listTree(request: FileTreeRequest): Promise<IpcResult<FileTreeResult>>;
  readFile(request: FileReadRequest): Promise<IpcResult<FileReadResult>>;
  writeFile(request: FileWriteRequest): Promise<IpcResult<true>>;
}

export interface DiagnosticsApi {
  list(): Promise<IpcResult<DiagnosticItem[]>>;
  crashLogs(request?: DiagnosticLogsRequest): Promise<IpcResult<CrashLogSummary[]>>;
  sessionHookTrace(
    request?: ListSessionHookTraceRequest
  ): Promise<IpcResult<SessionHookTraceEvent[]>>;
  clearSessionHookTrace(): Promise<IpcResult<true>>;
  onSessionHookEvent(listener: (event: SessionHookTraceEvent) => void): () => void;
}

export interface WindowApi {
  minimize(): Promise<IpcResult<true>>;
  toggleMaximize(): Promise<IpcResult<true>>;
  zoomIn(): Promise<IpcResult<number>>;
  zoomOut(): Promise<IpcResult<number>>;
  openSessionEventsDebug(): Promise<IpcResult<true>>;
  close(): Promise<IpcResult<true>>;
}

export type AgentIntegrationHostKind = 'windows' | 'linux' | 'macos' | 'wsl';

export type AgentIntegrationHostKey =
  | { kind: 'windows' }
  | { kind: 'linux' }
  | { kind: 'macos' }
  | { kind: 'wsl'; distro: string };

export interface AgentIntegrationHost {
  kind: AgentIntegrationHostKind;
  distro?: string;
  label: string;
  available: boolean;
  reason?: string;
}

export interface AgentIntegrationTargetStatus {
  installed: boolean;
  current: boolean;
  version?: number;
  cli?: AgentCliAvailability;
}

export interface AgentCliAvailability {
  available: boolean;
  binary?: string;
  version?: string;
  reason?: string;
}

export interface AgentIntegrationHostStatus {
  host: AgentIntegrationHost;
  claude: AgentIntegrationTargetStatus;
  codex: AgentIntegrationTargetStatus;
  cursor: AgentIntegrationTargetStatus;
  opencode: AgentIntegrationTargetStatus;
  grok: AgentIntegrationTargetStatus;
}

export interface AgentIntegrationStatus {
  hosts: AgentIntegrationHostStatus[];
}

export interface AgentIntegrationClaudeRequest {
  host: AgentIntegrationHostKey;
}

export interface AgentIntegrationCodexRequest {
  host: AgentIntegrationHostKey;
}

export interface AgentIntegrationCursorRequest {
  host: AgentIntegrationHostKey;
}

export interface AgentIntegrationOpenCodeRequest {
  host: AgentIntegrationHostKey;
}

export interface AgentIntegrationGrokRequest {
  host: AgentIntegrationHostKey;
}

export interface AgentIntegrationApi {
  status(): Promise<IpcResult<AgentIntegrationStatus>>;
  installClaude(request: AgentIntegrationClaudeRequest): Promise<IpcResult<AgentIntegrationStatus>>;
  uninstallClaude(
    request: AgentIntegrationClaudeRequest
  ): Promise<IpcResult<AgentIntegrationStatus>>;
  installCodex(request: AgentIntegrationCodexRequest): Promise<IpcResult<AgentIntegrationStatus>>;
  uninstallCodex(
    request: AgentIntegrationCodexRequest
  ): Promise<IpcResult<AgentIntegrationStatus>>;
  installCursor(request: AgentIntegrationCursorRequest): Promise<IpcResult<AgentIntegrationStatus>>;
  uninstallCursor(
    request: AgentIntegrationCursorRequest
  ): Promise<IpcResult<AgentIntegrationStatus>>;
  installOpenCode(
    request: AgentIntegrationOpenCodeRequest
  ): Promise<IpcResult<AgentIntegrationStatus>>;
  uninstallOpenCode(
    request: AgentIntegrationOpenCodeRequest
  ): Promise<IpcResult<AgentIntegrationStatus>>;
  installGrok(request: AgentIntegrationGrokRequest): Promise<IpcResult<AgentIntegrationStatus>>;
  uninstallGrok(request: AgentIntegrationGrokRequest): Promise<IpcResult<AgentIntegrationStatus>>;
  onChange(listener: (status: AgentIntegrationStatus) => void): () => void;
}

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error';

export interface ToastNotification {
  severity: ToastSeverity;
  message: string;
  description?: string;
}

export interface NotifyApi {
  onToast(listener: (toast: ToastNotification) => void): () => void;
  onActivateSession(listener: (sessionId: SessionId) => void): () => void;
}

export interface OverviewApi {
  get(request: import('./overview.js').GetOverviewRequest):
    Promise<IpcResult<import('./overview.js').WorktreeOverview>>;
  regenerate(request: import('./overview.js').RegenerateOverviewRequest):
    Promise<IpcResult<import('./overview.js').WorktreeOverview>>;
  askStart(request: import('./overview.js').AskFollowUpRequest):
    Promise<IpcResult<{ requestId: string }>>;
  askCancel(requestId: string): Promise<IpcResult<true>>;
  onChunk(listener: (chunk: import('./overview.js').AskFollowUpChunk) => void): () => void;
}

export interface CommentsApi {
  onRpcRequest(listener: (request: CommentsRpcRequest) => void): () => void;
  sendRpcResponse(response: CommentsRpcResponse): void;
}

export interface DiffBridgeApi {
  onRpcRequest(listener: (request: DiffRpcRequest) => void): () => void;
  sendRpcResponse(response: DiffRpcResponse): void;
}

export interface FeaturesApi {
  scan(request: FeatureScanRequest): Promise<IpcResult<FeatureSnapshot>>;
  setBranchStatus(
    request: FeatureSetBranchStatusRequest
  ): Promise<IpcResult<CoverageMapSnapshot>>;
  setIssueStatus(request: FeatureSetIssueStatusRequest): Promise<IpcResult<FeatureIssueEntry>>;
  subscribe(request: {
    cwd: string;
    runMode: import('./sessions.js').RunMode;
    wslDistro?: string;
  }): Promise<IpcResult<true>>;
  unsubscribe(request: {
    cwd: string;
    runMode: import('./sessions.js').RunMode;
    wslDistro?: string;
  }): Promise<IpcResult<true>>;
  onChange(listener: (event: FeatureChangeEvent) => void): () => void;
}

export interface VaultApi {
  list(request: VaultListRequest): Promise<IpcResult<VaultEntry[]>>;
  save(request: VaultSaveRequest): Promise<IpcResult<VaultEntry>>;
  update(request: VaultUpdateRequest): Promise<IpcResult<VaultEntry>>;
  delete(request: VaultDeleteRequest): Promise<IpcResult<true>>;
  getSecret(request: VaultGetSecretRequest): Promise<IpcResult<VaultSecret>>;
  onChange(cb: (event: VaultChangeEvent) => void): () => void;
}

export interface BrowserApi {
  enableDeviceEmulation(request: EnableDeviceEmulationRequest): Promise<IpcResult<true>>;
  disableDeviceEmulation(request: DisableDeviceEmulationRequest): Promise<IpcResult<true>>;
  setUserAgent(request: SetUserAgentRequest): Promise<IpcResult<true>>;
  openDevTools(request: OpenDevToolsRequest): Promise<IpcResult<true>>;
  setDevToolsLayout(request: SetDevToolsLayoutRequest): Promise<IpcResult<true>>;
  closeDevTools(request: CloseDevToolsRequest): Promise<IpcResult<true>>;
}

export interface BrowserSessionsApi {
  get(): Promise<IpcResult<BrowserSessionSnapshot>>;
  update(request: BrowserSessionUpdateRequest): Promise<IpcResult<true>>;
}

export interface TransportCapabilities {
  kind: import("../api-contract.js").SoloeTransportKind;
  supports(namespace: string, method: string): boolean;
}

export interface SoloeApi {
  transport?: TransportCapabilities;
  sessions: SessionsApi;
  terminal: TerminalApi;
  observer: ObserverApi;
  system: SystemApi;
  settings: SettingsApi;
  connections: ConnectionsApi;
  projects: ProjectsApi;
  notes: NotesApi;
  artifacts: ArtifactsApi;
  git: GitApi;
  files: FilesApi;
  diagnostics: DiagnosticsApi;
  window: WindowApi;
  agentIntegration: AgentIntegrationApi;
  notify: NotifyApi;
  overview: OverviewApi;
  comments: CommentsApi;
  diff: DiffBridgeApi;
  features: FeaturesApi;
  vault: VaultApi;
  browser: BrowserApi;
  browserSessions: BrowserSessionsApi;
}

declare global {
  interface Window {
    soloe: SoloeApi;
  }
}
