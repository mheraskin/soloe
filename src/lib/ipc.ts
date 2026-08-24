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
  ClipboardImagePayload,
  FileOpenRequest,
  FileReadRequest,
  FileReadResult,
  FileTreeRequest,
  FileTreeResult,
  FileWriteRequest,
  ImagePasteRequest,
  ImagePasteResult,
  FilePasteRequest,
  FileSearchRequest
} from '@shared/types/files.js';
import type { DiagnosticLogsRequest } from '@shared/types/diagnostics.js';
import type {
  AgentIntegrationClaudeRequest,
  AgentIntegrationCodexRequest,
  AgentIntegrationCursorRequest,
  AgentIntegrationStatus,
  ToastNotification
} from '@shared/types/ipc.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalInputLeaseEvent,
  TerminalControlProof,
  TerminalControllerIdentity,
  TerminalOutputEvent,
  TerminalHistorySnapshot,
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
  DeviceEventEnvelope,
  DeviceId,
  DevicePortForwardResult,
  SessionRef,
  TerminalRef
} from '@shared/types/devices.js';
import type {
  CreateMultiDeviceSessionRequest,
  DeviceWorktreeInvokeRequest,
  MultiDeviceSessionState
} from '@shared/types/multi-device-sessions.js';
import type {
  VaultChangeEvent,
  VaultDeleteRequest,
  VaultGetSecretRequest,
  VaultListRequest,
  VaultSaveRequest,
  VaultUpdateRequest
} from '@shared/types/vault.js';
import {
  TerminalSessionRegistry,
  type TerminalSessionState
} from './terminal-session';

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
const terminalReconnect = (
  c?.terminal as (typeof c.terminal & {
    onReconnect?: (listener: () => void) => () => void;
  }) | undefined
)?.onReconnect;
const terminalSessions = new TerminalSessionRegistry({
  subscribeOutput: (listener) => c.terminal.onOutput(listener),
  historySnapshot: async (terminalId) => unwrap(await c.terminal.historySnapshot(terminalId)),
  setOutputDemand: async (terminalId, active) => {
    unwrap(await c.terminal.setOutputDemand({ terminalId, active }));
  },
  onReconnect: terminalReconnect ? (listener) => terminalReconnect(listener) : undefined
});

const localBackend = {
  connection: {
    onReconnect: (listener: () => void) =>
      terminalReconnect ? terminalReconnect(listener) : () => {}
  },
  sessions: {
    devicesSupported: Boolean(c?.sessions.deviceState),
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
    deviceState: async (): Promise<MultiDeviceSessionState> => {
      if (!c.sessions.deviceState) throw new Error('Multi-Device Sessions are unavailable.');
      return unwrap(await c.sessions.deviceState());
    },
    refreshDevices: async (): Promise<MultiDeviceSessionState> => {
      if (!c.sessions.refreshDevices) throw new Error('Multi-Device Sessions are unavailable.');
      return unwrap(await c.sessions.refreshDevices());
    },
    reorderOnDevices: async (refs: SessionRef[]): Promise<MultiDeviceSessionState> => {
      if (!c.sessions.reorderOnDevices) throw new Error('Multi-Device Session ordering is unavailable.');
      return unwrap(await c.sessions.reorderOnDevices(toIpcPayload(refs)));
    },
    createOnDevice: async (request: CreateMultiDeviceSessionRequest) => {
      if (!c.sessions.createOnDevice) throw new Error('Multi-Device Sessions are unavailable.');
      return unwrap(await c.sessions.createOnDevice(toIpcPayload(request)));
    },
    planCreateOnDevice: async (request: CreateMultiDeviceSessionRequest) => {
      if (!c.sessions.planCreateOnDevice) throw new Error('Multi-Device Session planning is unavailable.');
      return unwrap(await c.sessions.planCreateOnDevice(toIpcPayload(request)));
    },
    executeCreateOnDevice: async (planId: string) => {
      if (!c.sessions.executeCreateOnDevice) throw new Error('Multi-Device Session creation is unavailable.');
      return unwrap(await c.sessions.executeCreateOnDevice(planId));
    },
    browseDeviceWorkspaceDirectories: async (
      request: import('@shared/types/multi-device-sessions.js').BrowseDeviceWorkspaceDirectoriesRequest
    ) => {
      if (!c.sessions.browseDeviceWorkspaceDirectories) {
        throw new Error('Device workspace browsing is unavailable.');
      }
      return unwrap(await c.sessions.browseDeviceWorkspaceDirectories(toIpcPayload(request)));
    },
    openProjectOnDevice: async (
      request: { deviceId: DeviceId; project: import('@shared/types/projects.js').ProjectOpenRequest }
    ) => {
      if (!c.sessions.openProjectOnDevice) throw new Error('Opening Projects on Devices is unavailable.');
      return unwrap(await c.sessions.openProjectOnDevice(toIpcPayload(request)));
    },
    executeDevicePreparation: async (planId: string) => {
      if (!c.sessions.executeDevicePreparation) {
        throw new Error('Device Project preparation is unavailable.');
      }
      return unwrap(await c.sessions.executeDevicePreparation(planId));
    },
    startOnDevice: async (ref: SessionRef) => {
      if (!c.sessions.startOnDevice) throw new Error('Multi-Device Session start is unavailable.');
      return unwrap(await c.sessions.startOnDevice(toIpcPayload(ref)));
    },
    updateOnDevice: async (ref: SessionRef, patch: SessionUpdate) => {
      if (!c.sessions.updateOnDevice) throw new Error('Multi-Device Session updates are unavailable.');
      return unwrap(await c.sessions.updateOnDevice(toIpcPayload({ ref, patch })));
    },
    deleteOnDevice: async (ref: SessionRef) => {
      if (!c.sessions.deleteOnDevice) throw new Error('Multi-Device Session deletion is unavailable.');
      return unwrap(await c.sessions.deleteOnDevice(toIpcPayload(ref)));
    },
    previewCommandOnDevice: async (ref: SessionRef) => {
      if (!c.sessions.previewCommandOnDevice) {
        throw new Error('Multi-Device Session command preview is unavailable.');
      }
      return unwrap(await c.sessions.previewCommandOnDevice(toIpcPayload(ref)));
    },
    ensureDeviceTailscalePort: async (
      deviceId: DeviceId,
      port: number,
      virtualHostname?: string
    ): Promise<DevicePortForwardResult> => {
      if (!c.sessions.ensureDeviceTailscalePort) {
        throw new Error('Tailscale port forwarding is unavailable.');
      }
      return unwrap(await c.sessions.ensureDeviceTailscalePort(
        toIpcPayload({ deviceId, port, ...(virtualHostname ? { virtualHostname } : {}) })
      ));
    },
    setDeviceTerminalDemand: async (refs: TerminalRef[]) => {
      if (!c.sessions.setDeviceTerminalDemand) {
        throw new Error('Multi-Device terminal output is unavailable.');
      }
      return unwrap(await c.sessions.setDeviceTerminalDemand(toIpcPayload(refs)));
    },
    deviceTerminalInput: async (ref: TerminalRef, data: string, control: TerminalControlProof) => {
      if (!c.sessions.deviceTerminalInput) {
        throw new Error('Multi-Device terminal input is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalInput(toIpcPayload({ ref, data, control })));
    },
    deviceTerminalPasteImages: async (
      ref: TerminalRef,
      sessionId: string,
      images: ClipboardImagePayload[],
      control: TerminalControlProof
    ): Promise<ImagePasteResult> => {
      if (!c.sessions.deviceTerminalPasteImages) {
        throw new Error('Multi-Device image paste is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalPasteImages(
        toIpcPayload({ ref, sessionId, images, control })
      ));
    },
    deviceTerminalInputLease: async (ref: TerminalRef, takeover = false) => {
      if (!c.sessions.deviceTerminalInputLease) {
        throw new Error('Multi-Device terminal input control is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalInputLease(toIpcPayload({ ref, takeover })));
    },
    deviceTerminalCurrentInputLease: async (ref: TerminalRef) => {
      if (!c.sessions.deviceTerminalCurrentInputLease) {
        throw new Error('Multi-Device terminal input control is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalCurrentInputLease(toIpcPayload(ref)));
    },
    deviceTerminalReleaseInputLease: async (ref: TerminalRef, control: TerminalControlProof) => {
      if (!c.sessions.deviceTerminalReleaseInputLease) {
        throw new Error('Multi-Device terminal input control is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalReleaseInputLease(
        toIpcPayload({ ref, control })
      ));
    },
    deviceTerminalParkInputLease: async (ref: TerminalRef, control: TerminalControlProof) => {
      if (!c.sessions.deviceTerminalParkInputLease) {
        throw new Error('Multi-Device terminal input control is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalParkInputLease(
        toIpcPayload({ ref, control })
      ));
    },
    deviceTerminalResize: async (
      ref: TerminalRef,
      cols: number,
      rows: number,
      control: TerminalControlProof
    ) => {
      if (!c.sessions.deviceTerminalResize) {
        throw new Error('Multi-Device terminal resize is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalResize(
        toIpcPayload({ ref, cols, rows, control })
      ));
    },
    deviceTerminalHistory: async (ref: TerminalRef) => {
      if (!c.sessions.deviceTerminalHistory) {
        throw new Error('Multi-Device terminal history is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalHistory(toIpcPayload(ref)));
    },
    deviceTerminalStop: async (ref: TerminalRef) => {
      if (!c.sessions.deviceTerminalStop) {
        throw new Error('Multi-Device terminal stop is unavailable.');
      }
      return unwrap(await c.sessions.deviceTerminalStop(toIpcPayload(ref)));
    },
    invokeWorktree: async (request: DeviceWorktreeInvokeRequest): Promise<unknown> => {
      if (!c.sessions.invokeWorktree) {
        throw new Error('Remote Worktree data is unavailable.');
      }
      return unwrap(await c.sessions.invokeWorktree(toIpcPayload(request)));
    },
    onChange: (cb: (session: Session) => void) => c.sessions.onChange(cb),
    onDelete: (cb: (sessionId: SessionId) => void) => c.sessions.onDelete(cb),
    onDeviceStateChange: (cb: (state: MultiDeviceSessionState) => void) =>
      c.sessions.onDeviceStateChange?.(cb) ?? (() => undefined),
    onDeviceEvent: (cb: (event: DeviceEventEnvelope) => void) =>
      c.sessions.onDeviceEvent?.(cb) ?? (() => undefined)
  },
  terminal: {
    start: async (opts: TerminalStartOptions) => unwrap(await c.terminal.start(toIpcPayload(opts))),
    stop: async (terminalId: TerminalId) => unwrap(await c.terminal.stop(terminalId)),
    restart: async (sessionId: SessionId, opts?: { cols?: number; rows?: number }) =>
      unwrap(await c.terminal.restart(sessionId, opts ? toIpcPayload(opts) : undefined)),
    acquireInputLease: async (
      terminalId: TerminalId,
      controller: TerminalControllerIdentity,
      takeover = false
    ) => unwrap(await c.terminal.acquireInputLease(
      terminalId,
      toIpcPayload(controller),
      takeover
    )),
    currentInputLease: async (terminalId: TerminalId) =>
      unwrap(await c.terminal.currentInputLease(terminalId)),
    releaseInputLease: async (terminalId: TerminalId, control: TerminalControlProof) =>
      unwrap(await c.terminal.releaseInputLease(terminalId, toIpcPayload(control))),
    parkInputLease: async (terminalId: TerminalId, control: TerminalControlProof) =>
      unwrap(await c.terminal.parkInputLease(terminalId, toIpcPayload(control))),
    input: async (terminalId: TerminalId, data: string, control: TerminalControlProof) =>
      unwrap(await c.terminal.input(toIpcPayload({ terminalId, data, control }))),
    resize: async (
      terminalId: TerminalId,
      cols: number,
      rows: number,
      control: TerminalControlProof
    ) => unwrap(await c.terminal.resize(toIpcPayload({
      terminalId,
      dimensions: { cols, rows },
      control
    }))),
    listRunning: async () => unwrap(await c.terminal.listRunning()),
    historySnapshot: async (terminalId: TerminalId): Promise<TerminalHistorySnapshot | null> =>
      unwrap(await c.terminal.historySnapshot(terminalId)),
    attachSession: (
      terminalId: TerminalId,
      sessionId: SessionId,
      listener: (state: TerminalSessionState) => void,
      initiallyVisible: boolean
    ) => terminalSessions.connect(terminalId, sessionId, listener, initiallyVisible),
    onExit: (cb: (event: TerminalExitEvent) => void) => c.terminal.onExit(cb),
    onStatus: (cb: (event: TerminalStatusEvent) => void) => c.terminal.onStatus(cb),
    onLocation: (cb: (event: TerminalLocationEvent) => void) => c.terminal.onLocation(cb),
    onInputLease: (cb: (event: TerminalInputLeaseEvent) => void) =>
      c.terminal.onInputLease(cb)
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
    configure: async (patch: import('@shared/types/connections.js').ConnectionPreferencesUpdate) =>
      unwrap(await c.connections.configure(toIpcPayload(patch))),
    setupShortDns: async () => {
      if (!c.connections.setupShortDns) {
        throw new Error('Short DNS setup must be run from Soloe on that Device.');
      }
      return unwrap(await c.connections.setupShortDns());
    },
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
    list: async (projectId: ProjectId, _route?: WorktreeRoute) =>
      unwrap(await c.notes.list(projectId)),
    read: async (projectId: ProjectId, filename: string, _route?: WorktreeRoute) =>
      unwrap(await c.notes.read(projectId, filename)),
    write: async (
      projectId: ProjectId,
      filename: string,
      content: string,
      expectedRevision?: string | null,
      _route?: WorktreeRoute
    ) =>
      unwrap(await c.notes.write(projectId, filename, content, expectedRevision)),
    rename: async (
      projectId: ProjectId,
      oldName: string,
      newName: string,
      _route?: WorktreeRoute
    ) =>
      unwrap(await c.notes.rename(projectId, oldName, newName)),
    delete: async (projectId: ProjectId, filename: string, _route?: WorktreeRoute) =>
      unwrap(await c.notes.delete(projectId, filename)),
    saveImage: async (
      projectId: ProjectId,
      mimeType: string,
      dataBase64: string,
      _route?: WorktreeRoute
    ) =>
      unwrap(await c.notes.saveImage(projectId, mimeType, dataBase64)),
    readImage: async (absolutePath: string, _route?: WorktreeRoute) =>
      unwrap(await c.notes.readImage(absolutePath)),
    cleanupImages: async (
      projectId: ProjectId,
      extraReferences: string[],
      _route?: WorktreeRoute
    ) =>
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
    installCursor: async (request: AgentIntegrationCursorRequest) =>
      unwrap(await c.agentIntegration.installCursor(toIpcPayload(request))),
    uninstallCursor: async (request: AgentIntegrationCursorRequest) =>
      unwrap(await c.agentIntegration.uninstallCursor(toIpcPayload(request))),
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
    askCancel: async (requestId: string, _route?: WorktreeRoute) =>
      unwrap(await c.overview.askCancel(requestId)),
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

interface WorktreeRoute {
  deviceId?: DeviceId;
}

const WORKTREE_EVENT_METHODS: Partial<Record<string, Record<string, string>>> = {
  notes: { onChange: 'notes.change' },
  git: { onChange: 'git.change' },
  overview: { onChunk: 'overview.chunk' },
  features: { onChange: 'features.change' },
  vault: { onChange: 'vault.change' }
};

function routedWorktreeNamespace<T extends object>(namespace: string, local: T): T {
  return new Proxy(local, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const deviceEvent = WORKTREE_EVENT_METHODS[namespace]?.[property];
      if (deviceEvent) {
        return (listener: (payload: unknown) => void) => {
          const detachLocal = Reflect.apply(value, target, [listener]) as () => void;
          const detachDevice = localBackend.sessions.onDeviceEvent((event) => {
            if (event.event !== deviceEvent || !isRecord(event.payload)) return;
            listener({ ...event.payload, deviceId: event.deviceId });
          });
          return () => {
            detachLocal();
            detachDevice();
          };
        };
      }
      return (...input: unknown[]) => {
        const routed = extractWorktreeRoute(input);
        if (!routed.deviceId) return Reflect.apply(value, target, routed.args);
        return localBackend.sessions.invokeWorktree({
          deviceId: routed.deviceId,
          namespace: namespace as DeviceWorktreeInvokeRequest['namespace'],
          method: property,
          args: routed.args
        });
      };
    }
  });
}

function extractWorktreeRoute(input: unknown[]): { deviceId: DeviceId | null; args: unknown[] } {
  let deviceId: DeviceId | null = null;
  const args: unknown[] = [];
  for (const value of input) {
    if (!isRecord(value) || typeof value['deviceId'] !== 'string') {
      args.push(value);
      continue;
    }
    deviceId = value['deviceId'];
    const { deviceId: _deviceId, ...payload } = value;
    if (Object.keys(payload).length > 0) args.push(payload);
  }
  return { deviceId, args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const backend: typeof localBackend = {
  ...localBackend,
  notes: routedWorktreeNamespace('notes', localBackend.notes),
  git: routedWorktreeNamespace('git', localBackend.git),
  files: routedWorktreeNamespace('files', localBackend.files),
  overview: routedWorktreeNamespace('overview', localBackend.overview),
  features: routedWorktreeNamespace('features', localBackend.features),
  vault: routedWorktreeNamespace('vault', localBackend.vault)
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
