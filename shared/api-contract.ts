export type SoloeTransportKind = "local-electron" | "remote-electron" | "browser";

export const UI_STARTUP_RPCS = [
  "system.platform",
  "settings.get",
  "projects.list",
  "sessions.list",
  "sessions.listArchived",
  "terminal.listRunning",
  "observer.list",
  "agentIntegration.status",
] as const;

export const SERVER_RPC_METHODS = new Set<string>([
  "sessions.list",
  "sessions.listArchived",
  "sessions.get",
  "sessions.create",
  "sessions.update",
  "sessions.delete",
  "sessions.reorder",
  "sessions.previewCommand",
  "terminal.start",
  "terminal.stop",
  "terminal.restart",
  "terminal.input",
  "terminal.resize",
  "terminal.listRunning",
  "terminal.replay",
  "terminal.setOutputDemand",
  "observer.list",
  "observer.listEvents",
  "observer.createWorkerSession",
  "observer.sendWorkerPrompt",
  "observer.getWorkerStatus",
  "observer.stopWorkerSession",
  "settings.get",
  "settings.update",
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
  "system.platform",
  "system.listWslDistros",
  "agentIntegration.status",
]);

export const REMOTE_ELECTRON_NATIVE_METHODS = new Set<string>([
  "window.minimize",
  "window.toggleMaximize",
  "window.zoomIn",
  "window.zoomOut",
  "window.close",
  "browser.enableDeviceEmulation",
  "browser.disableDeviceEmulation",
  "browser.setUserAgent",
  "browser.openDevTools",
  "browser.setDevToolsLayout",
  "browser.closeDevTools",
]);

export function supportsRpc(
  transport: SoloeTransportKind,
  namespace: string,
  method: string,
): boolean {
  if (transport === "local-electron") return true;
  const key = `${namespace}.${method}`;
  if (SERVER_RPC_METHODS.has(key)) return true;
  return transport === "remote-electron" && REMOTE_ELECTRON_NATIVE_METHODS.has(key);
}
