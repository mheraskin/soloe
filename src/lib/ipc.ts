import type { IpcResult } from '@shared/types/ipc.js';
import type {
  CreateWorkerSessionRequest,
  ListObserverEventsRequest,
  ObservedAgentSnapshot,
  ObserverEvent,
  SendWorkerPromptRequest
} from '@shared/types/agents.js';
import type {
  RunMode,
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
  ProjectOpenRequest,
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
  CommitsBetweenRequest,
  DiscardFilesRequest,
  FileBlameRequest,
  FileDiffRequest,
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
  FileOpenRequest,
  FileReadRequest,
  FileReadResult,
  FileTreeRequest,
  FileTreeResult,
  FileWriteRequest,
  ImagePasteRequest,
  FilePasteRequest,
  FileSearchRequest
} from '@shared/types/files.js';
import type { DiagnosticLogsRequest } from '@shared/types/diagnostics.js';
import type {
  AgentIntegrationClaudeRequest,
  AgentIntegrationCodexRequest,
  AgentIntegrationStatus,
  ToastNotification
} from '@shared/types/ipc.js';
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
import type {
  CloseDevToolsRequest,
  DisableDeviceEmulationRequest,
  EnableDeviceEmulationRequest,
  OpenDevToolsRequest,
  SetDevToolsLayoutRequest,
  SetUserAgentRequest
} from '@shared/types/browser.js';
import type {
  BrowserSessionSnapshot,
  BrowserSessionUpdateRequest
} from '@shared/types/browser-sessions.js';
import type { CommentsRpcRequest, CommentsRpcResponse } from '@shared/types/comments-rpc.js';
import type { DiffRpcRequest, DiffRpcResponse } from '@shared/types/diff-rpc.js';
import type {
  CockpitCatalogExportBundle,
  CockpitCatalogImportRequest,
  CockpitCatalogImportResult,
  CockpitDemand,
  CockpitEvent,
  CockpitTerminalInputRequest,
  CockpitTerminalInputLeaseRequest,
  CockpitTerminalReplayRequest,
  CockpitTerminalResizeRequest,
  CockpitTerminalStopRequest
} from '@shared/types/cockpit.js';
import type { DeviceId } from '@shared/types/devices.js';
import type {
  CatalogTransaction,
  CockpitAlignWorkspaceIntent,
  CockpitAlignWorkspaceOperation,
  CockpitAlignWorkspacePlan,
  CockpitPlaceSessionIntent,
  CockpitPlaceSessionOperation,
  CockpitPlaceSessionPlan,
  CockpitSessionSourceLifecycleIntent,
  CockpitSessionSourceLifecycleOperation,
  CockpitSessionSourceLifecyclePlan,
  DeviceWorkspaceIntent,
  DeviceWorkspacePlan
} from '@shared/types/workspaces.js';
import type {
  CockpitOperation,
  DeviceCommandEnvelope,
  DeviceOperationReceipt
} from '@shared/types/commands.js';
import type {
  CockpitPublishProjectIntent,
  CockpitPublishProjectOperation,
  CockpitPublishProjectPlan
} from '@shared/types/providers.js';
import type {
  VaultChangeEvent,
  VaultDeleteRequest,
  VaultGetSecretRequest,
  VaultListRequest,
  VaultSaveRequest,
  VaultUpdateRequest
} from '@shared/types/vault.js';
import { TerminalOutputRouter } from './terminal-output-router';

function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) {
    const error = new Error(r.error) as Error & { code?: string; remediation?: string };
    if (r.code) error.code = r.code;
    if (r.remediation) error.remediation = r.remediation;
    throw error;
  }
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
function requiredCockpit(): NonNullable<Window['soloe']['cockpit']> {
  const cockpit = c?.cockpit;
  if (!cockpit) throw new Error('Multi-Device cockpit is unavailable in this host.');
  return cockpit;
}
const terminalReconnect = (
  c?.terminal as (typeof c.terminal & {
    onReconnect?: (listener: () => void) => () => void;
  }) | undefined
)?.onReconnect;
const terminalOutputRouter = new TerminalOutputRouter(
  (listener) => c.terminal.onOutput(listener),
  async (terminalId, afterSeq) => unwrap(await c.terminal.replay(terminalId, afterSeq)),
  async (terminalId, active) => {
    unwrap(await c.terminal.setOutputDemand({ terminalId, active }));
  },
  terminalReconnect ? (listener) => terminalReconnect(listener) : undefined
);

export const backend = {
  connection: {
    onReconnect: (listener: () => void) =>
      terminalReconnect ? terminalReconnect(listener) : () => {}
  },
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
    previewCommand: async (id: SessionId) => unwrap(await c.sessions.previewCommand(id)),
    onChange: (cb: (session: Session) => void) => c.sessions.onChange(cb),
    onDelete: (cb: (sessionId: SessionId) => void) => c.sessions.onDelete(cb)
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
    replay: async (terminalId: TerminalId, afterSeq = 0) =>
      unwrap(await c.terminal.replay(terminalId, afterSeq)),
    attachPresentation: (
      terminalId: TerminalId,
      sessionId: SessionId,
      sink: Parameters<TerminalOutputRouter['attach']>[2],
      initiallyVisible: boolean
    ) => terminalOutputRouter.attach(terminalId, sessionId, sink, initiallyVisible),
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
  browser: {
    enableDeviceEmulation: async (request: EnableDeviceEmulationRequest) =>
      unwrap(await c.browser.enableDeviceEmulation(toIpcPayload(request))),
    disableDeviceEmulation: async (request: DisableDeviceEmulationRequest) =>
      unwrap(await c.browser.disableDeviceEmulation(toIpcPayload(request))),
    setUserAgent: async (request: SetUserAgentRequest) =>
      unwrap(await c.browser.setUserAgent(toIpcPayload(request))),
    openDevTools: async (request: OpenDevToolsRequest) =>
      unwrap(await c.browser.openDevTools(toIpcPayload(request))),
    setDevToolsLayout: async (request: SetDevToolsLayoutRequest) =>
      unwrap(await c.browser.setDevToolsLayout(toIpcPayload(request))),
    closeDevTools: async (request: CloseDevToolsRequest) =>
      unwrap(await c.browser.closeDevTools(toIpcPayload(request)))
  },
  browserSessions: {
    get: async (): Promise<BrowserSessionSnapshot> =>
      unwrap(await c.browserSessions.get()),
    update: async (request: BrowserSessionUpdateRequest) =>
      unwrap(await c.browserSessions.update(toIpcPayload(request)))
  },
  system: {
    platform: async () => unwrap(await c.system.platform()),
    openPath: async (sessionId: SessionId) => unwrap(await c.system.openPath(sessionId)),
    saveText: async (request: { defaultPath?: string; content: string }) =>
      unwrap(await c.system.saveText(toIpcPayload(request))),
    openExternal: async (url: string) => unwrap(await c.system.openExternal(url)),
    listWslDistros: async () => unwrap(await c.system.listWslDistros()),
    usage: async (request?: SystemUsageRequest) =>
      unwrap(await c.system.usage(request ? toIpcPayload(request) : undefined))
  },
  settings: {
    get: async () => unwrap(await c.settings.get()),
    update: async (patch: SettingsUpdate) => unwrap(await c.settings.update(toIpcPayload(patch))),
    modelCatalog: async () => unwrap(await c.settings.modelCatalog()),
    onChange: (cb: (s: Settings) => void) => c.settings.onChange(cb)
  },
  connections: {
    get: async () => unwrap(await c.connections.get()),
    refresh: async () => unwrap(await c.connections.refresh()),
    add: async (request: Parameters<typeof c.connections.add>[0]) =>
      unwrap(await c.connections.add(toIpcPayload(request))),
    remove: async (id: Parameters<typeof c.connections.remove>[0]) =>
      unwrap(await c.connections.remove(id)),
    setEnabled: async (
      id: Parameters<typeof c.connections.setEnabled>[0],
      enabled: Parameters<typeof c.connections.setEnabled>[1]
    ) => unwrap(await c.connections.setEnabled(id, enabled)),
    select: async (id: Parameters<typeof c.connections.select>[0]) =>
      unwrap(await c.connections.select(id)),
    onChange: (cb: Parameters<typeof c.connections.onChange>[0]) => c.connections.onChange(cb)
  },
  cockpit: {
    supported: Boolean(c?.cockpit),
    snapshot: async () => unwrap(await requiredCockpit().snapshot()),
    refresh: async () => unwrap(await requiredCockpit().refresh()),
    setDemand: async (demand: CockpitDemand) =>
      unwrap(await requiredCockpit().setDemand(toIpcPayload(demand))),
    setFilter: async (deviceIds: DeviceId[]) =>
      unwrap(await requiredCockpit().setFilter([...deviceIds])),
    setDefaultPlacement: async (deviceId: DeviceId) =>
      unwrap(await requiredCockpit().setDefaultPlacement(deviceId)),
    transactCatalog: async (transaction: CatalogTransaction) =>
      unwrap(await requiredCockpit().transactCatalog(toIpcPayload(transaction))),
    exportCatalog: async (): Promise<CockpitCatalogExportBundle> =>
      unwrap(await requiredCockpit().exportCatalog()),
    importCatalog: async (
      request: CockpitCatalogImportRequest
    ): Promise<CockpitCatalogImportResult> =>
      unwrap(await requiredCockpit().importCatalog(toIpcPayload(request))),
    workspacePlan: async (
      deviceId: DeviceId,
      intent: DeviceWorkspaceIntent
    ): Promise<DeviceWorkspacePlan> =>
      unwrap(await requiredCockpit().workspacePlan(deviceId, toIpcPayload(intent))),
    workspaceExecute: async (
      command: DeviceCommandEnvelope<DeviceWorkspaceIntent>
    ): Promise<DeviceOperationReceipt> =>
      unwrap(await requiredCockpit().workspaceExecute(toIpcPayload(command))),
    workspaceGetCommand: async (
      deviceId: DeviceId,
      cockpitId: string,
      commandId: string
    ): Promise<DeviceOperationReceipt | null> =>
      unwrap(await requiredCockpit().workspaceGetCommand(deviceId, cockpitId, commandId)),
    placementPlan: async (
      intent: CockpitPlaceSessionIntent
    ): Promise<CockpitPlaceSessionPlan> =>
      unwrap(await requiredCockpit().placementPlan(toIpcPayload(intent))),
    placementExecute: async (
      planId: string,
      acknowledgements: string[]
    ): Promise<CockpitPlaceSessionOperation> =>
      unwrap(await requiredCockpit().placementExecute(planId, [...acknowledgements])),
    alignmentPlan: async (
      intent: CockpitAlignWorkspaceIntent
    ): Promise<CockpitAlignWorkspacePlan> =>
      unwrap(await requiredCockpit().alignmentPlan(toIpcPayload(intent))),
    alignmentExecute: async (
      planId: string,
      acknowledgements: string[]
    ): Promise<CockpitAlignWorkspaceOperation> =>
      unwrap(await requiredCockpit().alignmentExecute(planId, [...acknowledgements])),
    publicationPlan: async (
      intent: CockpitPublishProjectIntent
    ): Promise<CockpitPublishProjectPlan> =>
      unwrap(await requiredCockpit().publicationPlan(toIpcPayload(intent))),
    publicationExecute: async (
      planId: string,
      acknowledgements: string[]
    ): Promise<CockpitPublishProjectOperation> =>
      unwrap(await requiredCockpit().publicationExecute(planId, [...acknowledgements])),
    sourceLifecyclePlan: async (
      intent: CockpitSessionSourceLifecycleIntent
    ): Promise<CockpitSessionSourceLifecyclePlan> =>
      unwrap(await requiredCockpit().sourceLifecyclePlan(toIpcPayload(intent))),
    sourceLifecycleExecute: async (
      planId: string,
      acknowledgements: string[]
    ): Promise<CockpitSessionSourceLifecycleOperation> =>
      unwrap(await requiredCockpit().sourceLifecycleExecute(planId, [...acknowledgements])),
    operationGet: async (
      operationId: string
    ): Promise<CockpitOperation | null> =>
      unwrap(await requiredCockpit().operationGet(operationId)),
    operationListRecoverable: async (): Promise<CockpitOperation[]> =>
      unwrap(await requiredCockpit().operationListRecoverable()),
    terminalInput: async (request: CockpitTerminalInputRequest) =>
      unwrap(await requiredCockpit().terminalInput(toIpcPayload(request))),
    terminalInputLease: async (request: CockpitTerminalInputLeaseRequest) =>
      unwrap(await requiredCockpit().terminalInputLease(toIpcPayload(request))),
    terminalResize: async (request: CockpitTerminalResizeRequest) =>
      unwrap(await requiredCockpit().terminalResize(toIpcPayload(request))),
    terminalReplay: async (request: CockpitTerminalReplayRequest) =>
      unwrap(await requiredCockpit().terminalReplay(toIpcPayload(request))),
    terminalStop: async (request: CockpitTerminalStopRequest) =>
      unwrap(await requiredCockpit().terminalStop(toIpcPayload(request))),
    onEvent: (listener: (event: CockpitEvent) => void) =>
      requiredCockpit().onEvent(listener)
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
    refreshFavicons: async (id: ProjectId) => unwrap(await c.projects.refreshFavicons(id)),
    readFavicon: async (id: ProjectId, relativePath: string) =>
      unwrap(await c.projects.readFavicon(id, relativePath)),
    detectFromPath: async (p: string) => unwrap(await c.projects.detectFromPath(p)),
    suggestPaths: async (query: string, options?: ProjectSuggestOptions) =>
      unwrap(await c.projects.suggestPaths(query, options ? toIpcPayload(options) : undefined)),
    onChange: (cb: (projects: Project[]) => void) => c.projects.onChange(cb)
  },
  notes: {
    list: async (projectId: ProjectId) => unwrap(await c.notes.list(projectId)),
    read: async (projectId: ProjectId, filename: string) =>
      unwrap(await c.notes.read(projectId, filename)),
    write: async (
      projectId: ProjectId,
      filename: string,
      content: string,
      expectedRevision?: string | null
    ) =>
      unwrap(await c.notes.write(projectId, filename, content, expectedRevision)),
    rename: async (projectId: ProjectId, oldName: string, newName: string) =>
      unwrap(await c.notes.rename(projectId, oldName, newName)),
    delete: async (projectId: ProjectId, filename: string) =>
      unwrap(await c.notes.delete(projectId, filename)),
    saveImage: async (projectId: ProjectId, mimeType: string, dataBase64: string) =>
      unwrap(await c.notes.saveImage(projectId, mimeType, dataBase64)),
    readImage: async (absolutePath: string) => unwrap(await c.notes.readImage(absolutePath)),
    cleanupImages: async (projectId: ProjectId, extraReferences: string[]) =>
      unwrap(await c.notes.cleanupImages(projectId, [...extraReferences])),
    onChange: (cb: (event: NotesChangeEvent) => void) => c.notes.onChange(cb)
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
    refHistory: async (request: GitRefHistoryRequest) =>
      unwrap(await c.git.refHistory(toIpcPayload(request))),
    checkout: async (request: GitCheckoutRequest) =>
      unwrap(await c.git.checkout(toIpcPayload(request))),
    createWorktree: async (request: GitCreateWorktreeRequest) =>
      unwrap(await c.git.createWorktree(toIpcPayload(request))),
    workingChanges: async (request: WorkingChangesRequest) =>
      unwrap(await c.git.workingChanges(toIpcPayload(request))),
    workingTreeSnapshot: async (request: WorkingTreeSnapshotRequest) =>
      unwrap(await c.git.workingTreeSnapshot(toIpcPayload(request))),
    setObservationDemand: async (request: GitObservationDemandRequest) =>
      unwrap(await c.git.setObservationDemand(toIpcPayload(request))),
    rangeChanges: async (request: RangeChangesRequest) =>
      unwrap(await c.git.rangeChanges(toIpcPayload(request))),
    commitsBetween: async (request: CommitsBetweenRequest) =>
      unwrap(await c.git.commitsBetween(toIpcPayload(request))),
    resolveRefs: async (request: ResolveRefsRequest) =>
      unwrap(await c.git.resolveRefs(toIpcPayload(request))),
    fileBlame: async (request: FileBlameRequest) =>
      unwrap(await c.git.fileBlame(toIpcPayload(request))),
    fileDiff: async (request: FileDiffRequest) =>
      unwrap(await c.git.fileDiff(toIpcPayload(request))),
    reviewDiffs: async (request: ReviewDiffsRequest) =>
      unwrap(await c.git.reviewDiffs(toIpcPayload(request))),
    fileLines: async (request: FileLinesRequest) =>
      unwrap(await c.git.fileLines(toIpcPayload(request))),
    stageFiles: async (request: StageFilesRequest) =>
      unwrap(await c.git.stageFiles(toIpcPayload(request))),
    unstageFiles: async (request: StageFilesRequest) =>
      unwrap(await c.git.unstageFiles(toIpcPayload(request))),
    discardFiles: async (request: DiscardFilesRequest) =>
      unwrap(await c.git.discardFiles(toIpcPayload(request))),
    commit: async (request: GitCommitRequest) =>
      unwrap(await c.git.commit(toIpcPayload(request))),
    push: async (request: GitRemoteOpRequest) =>
      unwrap(await c.git.push(toIpcPayload(request))),
    pull: async (request: GitRemoteOpRequest) =>
      unwrap(await c.git.pull(toIpcPayload(request))),
    fetch: async (request: GitRemoteOpRequest) =>
      unwrap(await c.git.fetch(toIpcPayload(request))),
    onChange: (cb: (event: GitChangeEvent) => void) => c.git.onChange(cb)
  },
  files: {
    search: async (request: FileSearchRequest) => unwrap(await c.files.search(toIpcPayload(request))),
    openInEditor: async (request: FileOpenRequest) =>
      unwrap(await c.files.openInEditor(toIpcPayload(request))),
    pasteIntoTerminal: async (request: FilePasteRequest) =>
      unwrap(await c.files.pasteIntoTerminal(toIpcPayload(request))),
    pasteImagesIntoTerminal: async (request: ImagePasteRequest) =>
      unwrap(await c.files.pasteImagesIntoTerminal(toIpcPayload(request))),
    listTree: async (request: FileTreeRequest): Promise<FileTreeResult> =>
      unwrap(await c.files.listTree(toIpcPayload(request))),
    readFile: async (request: FileReadRequest): Promise<FileReadResult> =>
      unwrap(await c.files.readFile(toIpcPayload(request))),
    writeFile: async (request: FileWriteRequest) =>
      unwrap(await c.files.writeFile(toIpcPayload(request)))
  },
  diagnostics: {
    list: async () => unwrap(await c.diagnostics.list()),
    crashLogs: async (request?: DiagnosticLogsRequest) =>
      unwrap(await c.diagnostics.crashLogs(request ? toIpcPayload(request) : undefined))
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
  },
  notify: {
    onToast: (cb: (toast: ToastNotification) => void) => c.notify.onToast(cb),
    onActivateSession: (cb: (sessionId: SessionId) => void) =>
      c.notify.onActivateSession(cb)
  },
  overview: {
    get: async (request: GetOverviewRequest) =>
      unwrap(await c.overview.get(toIpcPayload(request))),
    regenerate: async (request: RegenerateOverviewRequest) =>
      unwrap(await c.overview.regenerate(toIpcPayload(request))),
    askStart: async (request: AskFollowUpRequest) =>
      unwrap(await c.overview.askStart(toIpcPayload(request))),
    askCancel: async (requestId: string) => unwrap(await c.overview.askCancel(requestId)),
    onChunk: (cb: (chunk: AskFollowUpChunk) => void) => c.overview.onChunk(cb)
  },
  comments: {
    onRpcRequest: (cb: (request: CommentsRpcRequest) => void) =>
      c.comments.onRpcRequest(cb),
    sendRpcResponse: (response: CommentsRpcResponse) =>
      c.comments.sendRpcResponse(toIpcPayload(response))
  },
  diff: {
    onRpcRequest: (cb: (request: DiffRpcRequest) => void) => c.diff.onRpcRequest(cb),
    sendRpcResponse: (response: DiffRpcResponse) =>
      c.diff.sendRpcResponse(toIpcPayload(response))
  },
  features: {
    scan: async (request: FeatureScanRequest) =>
      unwrap(await c.features.scan(toIpcPayload(request))),
    setBranchStatus: async (request: FeatureSetBranchStatusRequest) =>
      unwrap(await c.features.setBranchStatus(toIpcPayload(request))),
    setIssueStatus: async (request: FeatureSetIssueStatusRequest) =>
      unwrap(await c.features.setIssueStatus(toIpcPayload(request))),
    subscribe: async (request: {
      cwd: string;
      runMode: RunMode;
      wslDistro?: string;
    }) => unwrap(await c.features.subscribe(toIpcPayload(request))),
    unsubscribe: async (request: {
      cwd: string;
      runMode: RunMode;
      wslDistro?: string;
    }) => unwrap(await c.features.unsubscribe(toIpcPayload(request))),
    onChange: (cb: (event: FeatureChangeEvent) => void) => c.features.onChange(cb)
  },
  vault: {
    list: async (request: VaultListRequest) =>
      unwrap(await c.vault.list(toIpcPayload(request))),
    save: async (request: VaultSaveRequest) =>
      unwrap(await c.vault.save(toIpcPayload(request))),
    update: async (request: VaultUpdateRequest) =>
      unwrap(await c.vault.update(toIpcPayload(request))),
    delete: async (request: VaultDeleteRequest) =>
      unwrap(await c.vault.delete(toIpcPayload(request))),
    getSecret: async (request: VaultGetSecretRequest) =>
      unwrap(await c.vault.getSecret(toIpcPayload(request))),
    onChange: (cb: (event: VaultChangeEvent) => void) => c.vault.onChange(cb)
  }
};

/**
 * The renderer-facing backend Interface. Electron's preload bridge is the
 * current Adapter; a Tauri Adapter can replace it without changing Svelte
 * Modules or stores.
 */
export type RendererBackend = typeof backend;

/** @deprecated Use `backend`; retained while existing callers migrate. */
export const ipc = backend;

export function hasBackendTransport(): boolean {
  return typeof window !== 'undefined' && Boolean(window.soloe);
}

export function supportsBackendOperation(namespace: string, method: string): boolean {
  const transport = c?.transport;
  return transport ? transport.supports(namespace, method) : true;
}
