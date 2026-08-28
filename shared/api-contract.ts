export type SoloeTransportKind = "local-electron" | "remote-electron" | "browser";

export const SOLOE_API_METHODS = {
  sessions: [
    "list",
    "listArchived",
    "get",
    "create",
    "update",
    "delete",
    "reorder",
    "previewCommand",
    "deviceState",
    "refreshDevices",
    "reorderOnDevices",
    "createOnDevice",
    "planCreateOnDevice",
    "executeCreateOnDevice",
    "browseDeviceWorkspaceDirectories",
    "openProjectOnDevice",
    "updateProjectOnDevice",
    "deleteProjectOnDevice",
    "executeDevicePreparation",
    "startOnDevice",
    "updateOnDevice",
    "deleteOnDevice",
    "previewCommandOnDevice",
    "ensureDeviceTailscalePort",
    "setDeviceTerminalDemand",
    "deviceTerminalInput",
    "deviceTerminalPasteImages",
    "deviceTerminalInputLease",
    "deviceTerminalCurrentInputLease",
    "deviceTerminalReleaseInputLease",
    "deviceTerminalParkInputLease",
    "deviceTerminalResize",
    "deviceTerminalHistory",
    "deviceTerminalStop",
    "invokeWorktree",
    "onChange",
    "onDelete",
    "onDeviceStateChange",
    "onDeviceEvent",
  ],
  terminal: [
    "start",
    "stop",
    "restart",
    "acquireInputLease",
    "currentInputLease",
    "releaseInputLease",
    "parkInputLease",
    "input",
    "resize",
    "listRunning",
    "historySnapshot",
    "setOutputDemand",
    "onOutput",
    "onExit",
    "onStatus",
    "onLocation",
    "onInputLease",
  ],
  observer: [
    "list",
    "listEvents",
    "createWorkerSession",
    "sendWorkerPrompt",
    "getWorkerStatus",
    "stopWorkerSession",
    "onSnapshot",
    "onEvent",
  ],
  system: [
    "platform",
    "openPath",
    "saveText",
    "openExternal",
    "listWslDistros",
    "usage",
  ],
  settings: ["get", "update", "modelCatalog", "onChange"],
  connections: [
    "get",
    "refresh",
    "configure",
    "setupShortDns",
    "removeShortDns",
    "add",
    "remove",
    "setEnabled",
    "select",
    "onChange",
  ],
  projects: [
    "list",
    "get",
    "create",
    "open",
    "update",
    "delete",
    "touch",
    "reorder",
    "refreshFavicons",
    "readFavicon",
    "detectFromPath",
    "suggestPaths",
    "onChange",
  ],
  notes: [
    "list",
    "read",
    "write",
    "rename",
    "delete",
    "saveImage",
    "readImage",
    "cleanupImages",
    "onChange",
  ],
  git: [
    "status",
    "aheadBehind",
    "shortstat",
    "dirty",
    "worktrees",
    "branches",
    "recentCommits",
    "refHistory",
    "commitsBetween",
    "rangeChanges",
    "resolveRefs",
    "checkout",
    "createWorktree",
    "workingChanges",
    "workingTreeSnapshot",
    "setObservationDemand",
    "fileDiff",
    "reviewDiffs",
    "fileBlame",
    "fileLines",
    "stageFiles",
    "unstageFiles",
    "discardFiles",
    "commit",
    "push",
    "pull",
    "fetch",
    "onChange",
  ],
  files: [
    "search",
    "openInEditor",
    "pasteIntoTerminal",
    "pasteImagesIntoTerminal",
    "listTree",
    "readFile",
    "writeFile",
  ],
  diagnostics: [
    "list",
    "crashLogs",
    "sessionHookTrace",
    "clearSessionHookTrace",
    "onSessionHookEvent",
  ],
  window: [
    "minimize",
    "toggleMaximize",
    "zoomIn",
    "zoomOut",
    "openSessionEventsDebug",
    "close",
  ],
  agentIntegration: [
    "status",
    "installClaude",
    "uninstallClaude",
    "installCodex",
    "uninstallCodex",
    "installCursor",
    "uninstallCursor",
    "installOpenCode",
    "uninstallOpenCode",
    "installGrok",
    "uninstallGrok",
    "onChange",
  ],
  notify: ["onToast", "onActivateSession"],
  overview: ["get", "regenerate", "askStart", "askCancel", "onChunk"],
  comments: ["onRpcRequest", "sendRpcResponse"],
  diff: ["onRpcRequest", "sendRpcResponse"],
  features: [
    "scan",
    "setBranchStatus",
    "setIssueStatus",
    "subscribe",
    "unsubscribe",
    "onChange",
  ],
  vault: ["list", "save", "update", "delete", "getSecret", "onChange"],
  browser: [
    "enableDeviceEmulation",
    "disableDeviceEmulation",
    "setUserAgent",
    "openDevTools",
    "setDevToolsLayout",
    "closeDevTools",
  ],
  browserSessions: ["get", "update"],
} as const;

export const PWA_PANE_REQUIREMENTS = {
  diff: [
    "git.workingTreeSnapshot",
    "git.workingChanges",
    "git.fileDiff",
    "git.stageFiles",
    "git.unstageFiles",
  ],
  files: [
    "files.search",
    "files.listTree",
    "files.readFile",
    "files.writeFile",
    "files.openInEditor",
  ],
  feature: [
    "features.scan",
    "features.setBranchStatus",
    "features.setIssueStatus",
  ],
  notes: [
    "notes.list",
    "notes.read",
    "notes.write",
    "notes.rename",
    "notes.delete",
  ],
} as const;

export const UI_STARTUP_RPCS = [
  "system.platform",
  "settings.get",
  "settings.modelCatalog",
  "browserSessions.get",
  "projects.list",
  "sessions.list",
  "sessions.listArchived",
  "terminal.listRunning",
  "observer.list",
  "agentIntegration.status",
] as const;

/**
 * Authenticated Application Server RPCs used only by the host-private
 * multi-Device adapter. They are deliberately absent from renderer SoloeApi:
 * the Client exposes semantic plan/routing methods instead of raw forwarding.
 */
export const DEVICE_RPC_METHODS = new Set<string>([
  "git.remoteUrl",
  "githubProvider.status",
  "githubProvider.listOwners",
  "githubProvider.planCreateRepository",
  "githubProvider.execute",
  "githubProvider.getCommand",
  "workspaceDevice.snapshot",
  "workspaceDevice.plan",
  "workspaceDevice.execute",
  "workspaceDevice.getCommand",
  "sessions.createPlaced",
  "sessions.bindSource",
]);

/** Server events consumed only by the host-private multi-Device adapter. */
export const DEVICE_EVENT_METHODS = new Set<string>([
  "workspaceDevice.onChange",
]);

/** Renderer-visible Worktree operations that a multi-Device host may forward. */
export const DEVICE_WORKTREE_RPC_METHODS = new Set<string>([
  ...SOLOE_API_METHODS.notes
    .filter((method) => !method.startsWith("on"))
    .map((method) => `notes.${method}`),
  ...SOLOE_API_METHODS.git
    .filter((method) => !method.startsWith("on"))
    .map((method) => `git.${method}`),
  ...SOLOE_API_METHODS.files.map((method) => `files.${method}`),
  ...SOLOE_API_METHODS.overview
    .filter((method) => !method.startsWith("on"))
    .map((method) => `overview.${method}`),
  ...SOLOE_API_METHODS.features
    .filter((method) => !method.startsWith("on"))
    .map((method) => `features.${method}`),
  ...SOLOE_API_METHODS.vault
    .filter((method) => !method.startsWith("on"))
    .map((method) => `vault.${method}`),
]);

export const SERVER_RPC_METHODS = new Set<string>([
  ...DEVICE_RPC_METHODS,
  "sessions.list",
  "sessions.listArchived",
  "sessions.get",
  "sessions.create",
  "sessions.update",
  "sessions.delete",
  "sessions.reorder",
  "sessions.previewCommand",
  ...SOLOE_API_METHODS.sessions
    .filter((method) => !method.startsWith("on"))
    .map((method) => `sessions.${method}`),
  "terminal.start",
  "terminal.stop",
  "terminal.restart",
  "terminal.acquireInputLease",
  "terminal.currentInputLease",
  "terminal.releaseInputLease",
  "terminal.parkInputLease",
  "terminal.input",
  "terminal.resize",
  "terminal.listRunning",
  "terminal.historySnapshot",
  "terminal.setOutputDemand",
  "observer.list",
  "observer.listEvents",
  "observer.createWorkerSession",
  "observer.sendWorkerPrompt",
  "observer.getWorkerStatus",
  "observer.stopWorkerSession",
  "settings.get",
  "settings.update",
  "settings.modelCatalog",
  "projects.list",
  "projects.get",
  "projects.create",
  "projects.open",
  "projects.update",
  "projects.delete",
  "projects.touch",
  "projects.reorder",
  "projects.refreshFavicons",
  "projects.readFavicon",
  "projects.detectFromPath",
  "projects.suggestPaths",
  "files.search",
  "files.openInEditor",
  "files.pasteIntoTerminal",
  "files.pasteImagesIntoTerminal",
  "files.listTree",
  "files.readFile",
  "files.writeFile",
  "notes.list",
  "notes.read",
  "notes.write",
  "notes.rename",
  "notes.delete",
  "notes.saveImage",
  "notes.readImage",
  "notes.cleanupImages",
  "features.scan",
  "features.setBranchStatus",
  "features.setIssueStatus",
  "features.subscribe",
  "features.unsubscribe",
  "git.status",
  "git.aheadBehind",
  "git.shortstat",
  "git.dirty",
  "git.worktrees",
  "git.remoteUrl",
  "git.branches",
  "git.recentCommits",
  "git.refHistory",
  "git.commitsBetween",
  "git.rangeChanges",
  "git.resolveRefs",
  "git.checkout",
  "git.createWorktree",
  "git.workingChanges",
  "git.workingTreeSnapshot",
  "git.setObservationDemand",
  "git.fileDiff",
  "git.reviewDiffs",
  "git.fileBlame",
  "git.fileLines",
  "git.stageFiles",
  "git.unstageFiles",
  "git.discardFiles",
  "git.commit",
  "git.push",
  "git.pull",
  "git.fetch",
  "system.platform",
  "system.openPath",
  "system.listWslDistros",
  "system.usage",
  "overview.get",
  "overview.regenerate",
  "overview.askStart",
  "overview.askCancel",
  "diagnostics.list",
  "diagnostics.crashLogs",
  "diagnostics.sessionHookTrace",
  "diagnostics.clearSessionHookTrace",
  "vault.list",
  "vault.save",
  "vault.update",
  "vault.delete",
  "vault.getSecret",
  "browserSessions.get",
  "browserSessions.update",
  "agentIntegration.status",
  "agentIntegration.installClaude",
  "agentIntegration.uninstallClaude",
  "agentIntegration.installCodex",
  "agentIntegration.uninstallCodex",
  "agentIntegration.installCursor",
  "agentIntegration.uninstallCursor",
  "agentIntegration.installOpenCode",
  "agentIntegration.uninstallOpenCode",
  "agentIntegration.installGrok",
  "agentIntegration.uninstallGrok",
  "comments.sendRpcResponse",
  "diff.sendRpcResponse",
  ...SOLOE_API_METHODS.connections
    .filter((method) => !method.startsWith("on"))
    .map((method) => `connections.${method}`),
]);

export const REMOTE_ELECTRON_NATIVE_METHODS = new Set<string>([
  "window.minimize",
  "window.toggleMaximize",
  "window.zoomIn",
  "window.zoomOut",
  "window.openSessionEventsDebug",
  "window.close",
  "browser.enableDeviceEmulation",
  "browser.disableDeviceEmulation",
  "browser.setUserAgent",
  "browser.openDevTools",
  "browser.setDevToolsLayout",
  "browser.closeDevTools",
  ...SOLOE_API_METHODS.vault.map((method) => `vault.${method}`),
]);

export const CLIENT_NATIVE_METHODS = new Set<string>([
  "system.saveText",
  "system.openExternal",
]);

export const SERVER_EVENT_METHODS = new Set<string>([
  ...DEVICE_EVENT_METHODS,
  "sessions.onChange",
  "sessions.onDelete",
  "sessions.onDeviceStateChange",
  "sessions.onDeviceEvent",
  "terminal.onOutput",
  "terminal.onExit",
  "terminal.onStatus",
  "terminal.onLocation",
  "terminal.onInputLease",
  "observer.onSnapshot",
  "observer.onEvent",
  "diagnostics.onSessionHookEvent",
  "settings.onChange",
  "projects.onChange",
  "notes.onChange",
  "git.onChange",
  "agentIntegration.onChange",
  "overview.onChunk",
  "comments.onRpcRequest",
  "diff.onRpcRequest",
  "features.onChange",
  "vault.onChange",
  "connections.onChange",
]);

export const RUNTIME_OWNED_METHODS = new Set<string>([
  ...SOLOE_API_METHODS.terminal.map((method) => `terminal.${method}`),
  ...SOLOE_API_METHODS.observer.map((method) => `observer.${method}`),
]);

export type SoloeOperationOwner =
  | "application-server"
  | "runtime"
  | "client-native"
  | "local-electron"
  | "electron-native"
  | "unsupported";

export function operationOwner(
  transport: SoloeTransportKind,
  namespace: string,
  method: string,
): SoloeOperationOwner {
  const key = `${namespace}.${method}`;
  if (transport === "local-electron") {
    return REMOTE_ELECTRON_NATIVE_METHODS.has(key)
      ? "electron-native"
      : "local-electron";
  }
  if (CLIENT_NATIVE_METHODS.has(key)) return "client-native";
  if (
    transport === "remote-electron" &&
    REMOTE_ELECTRON_NATIVE_METHODS.has(key)
  ) {
    return "electron-native";
  }
  if (SERVER_RPC_METHODS.has(key) || SERVER_EVENT_METHODS.has(key)) {
    return RUNTIME_OWNED_METHODS.has(key) ? "runtime" : "application-server";
  }
  return "unsupported";
}

export function supportsRpc(
  transport: SoloeTransportKind,
  namespace: string,
  method: string,
): boolean {
  return operationOwner(transport, namespace, method) !== "unsupported";
}
