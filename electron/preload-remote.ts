import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannels,
  type BrowserApi,
  type CockpitApi,
  type ConnectionsApi,
  type VaultApi,
  type WindowApi
} from '@shared/types/ipc.js';
import type { CockpitEvent } from '@shared/types/cockpit.js';
import type { ConnectionSnapshot } from '@shared/types/connections.js';
import type { VaultChangeEvent } from '@shared/types/vault.js';
import type {
  CloseDevToolsRequest,
  DisableDeviceEmulationRequest,
  EnableDeviceEmulationRequest,
  OpenDevToolsRequest,
  SetDevToolsLayoutRequest,
  SetUserAgentRequest
} from '@shared/types/browser.js';
import { createBrowserApi } from '../src/lib/browser-api.js';

const serverUrl = process.env.SOLOE_CLIENT_SERVER_URL;
if (!serverUrl) {
  throw new Error('SOLOE_CLIENT_SERVER_URL is required for the remote Electron preload');
}
const tailscaleSession = process.env.SOLOE_CLIENT_TAILSCALE_SESSION === '1';

const api = createBrowserApi({
  baseUrl: serverUrl,
  transport: tailscaleSession ? 'browser' : 'remote-electron',
  ...(!tailscaleSession && process.env.SOLOE_SERVER_TOKEN
    ? { token: process.env.SOLOE_SERVER_TOKEN }
    : {})
});

const windowApi: WindowApi = {
  minimize: () => ipcRenderer.invoke(IpcChannels.window.minimize),
  toggleMaximize: () => ipcRenderer.invoke(IpcChannels.window.toggleMaximize),
  zoomIn: () => ipcRenderer.invoke(IpcChannels.window.zoomIn),
  zoomOut: () => ipcRenderer.invoke(IpcChannels.window.zoomOut),
  close: () => ipcRenderer.invoke(IpcChannels.window.close)
};

const browserApi: BrowserApi = {
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
};

const connectionsApi: ConnectionsApi = {
  get: () => ipcRenderer.invoke(IpcChannels.connections.get),
  refresh: () => ipcRenderer.invoke(IpcChannels.connections.refresh),
  add: (request) => ipcRenderer.invoke(IpcChannels.connections.add, request),
  remove: (id) => ipcRenderer.invoke(IpcChannels.connections.remove, id),
  setEnabled: (id, enabled) => ipcRenderer.invoke(IpcChannels.connections.enable, id, enabled),
  select: (id) => ipcRenderer.invoke(IpcChannels.connections.select, id),
  onChange: (cb) => subscribe<ConnectionSnapshot>(IpcChannels.connections.change, cb)
};

const cockpitApi: CockpitApi = {
  snapshot: () => ipcRenderer.invoke(IpcChannels.cockpit.snapshot),
  refresh: () => ipcRenderer.invoke(IpcChannels.cockpit.refresh),
  setDemand: (demand) => ipcRenderer.invoke(IpcChannels.cockpit.demand, demand),
  setFilter: (deviceIds) => ipcRenderer.invoke(IpcChannels.cockpit.filter, deviceIds),
  setDefaultPlacement: (deviceId) =>
    ipcRenderer.invoke(IpcChannels.cockpit.defaultPlacement, deviceId),
  transactCatalog: (transaction) =>
    ipcRenderer.invoke(IpcChannels.cockpit.transactCatalog, transaction),
  exportCatalog: () => ipcRenderer.invoke(IpcChannels.cockpit.exportCatalog),
  importCatalog: (request) => ipcRenderer.invoke(IpcChannels.cockpit.importCatalog, request),
  workspacePlan: (deviceId, intent) =>
    ipcRenderer.invoke(IpcChannels.cockpit.workspacePlan, deviceId, intent),
  workspaceExecute: (command) =>
    ipcRenderer.invoke(IpcChannels.cockpit.workspaceExecute, command),
  workspaceGetCommand: (deviceId, cockpitId, commandId) =>
    ipcRenderer.invoke(
      IpcChannels.cockpit.workspaceGetCommand,
      deviceId,
      cockpitId,
      commandId
    ),
  placementPlan: (intent) =>
    ipcRenderer.invoke(IpcChannels.cockpit.placementPlan, intent),
  placementExecute: (planId, acknowledgements) =>
    ipcRenderer.invoke(IpcChannels.cockpit.placementExecute, planId, acknowledgements),
  alignmentPlan: (intent) =>
    ipcRenderer.invoke(IpcChannels.cockpit.alignmentPlan, intent),
  alignmentExecute: (planId, acknowledgements) =>
    ipcRenderer.invoke(IpcChannels.cockpit.alignmentExecute, planId, acknowledgements),
  publicationPlan: (intent) =>
    ipcRenderer.invoke(IpcChannels.cockpit.publicationPlan, intent),
  publicationExecute: (planId, acknowledgements) =>
    ipcRenderer.invoke(IpcChannels.cockpit.publicationExecute, planId, acknowledgements),
  sourceLifecyclePlan: (intent) =>
    ipcRenderer.invoke(IpcChannels.cockpit.sourceLifecyclePlan, intent),
  sourceLifecycleExecute: (planId, acknowledgements) =>
    ipcRenderer.invoke(IpcChannels.cockpit.sourceLifecycleExecute, planId, acknowledgements),
  operationGet: (operationId) =>
    ipcRenderer.invoke(IpcChannels.cockpit.operationGet, operationId),
  operationListRecoverable: () =>
    ipcRenderer.invoke(IpcChannels.cockpit.operationListRecoverable),
  terminalInput: (request) => ipcRenderer.invoke(IpcChannels.cockpit.terminalInput, request),
  terminalInputLease: (request) =>
    ipcRenderer.invoke(IpcChannels.cockpit.terminalInputLease, request),
  terminalResize: (request) => ipcRenderer.invoke(IpcChannels.cockpit.terminalResize, request),
  terminalReplay: (request) => ipcRenderer.invoke(IpcChannels.cockpit.terminalReplay, request),
  terminalStop: (request) => ipcRenderer.invoke(IpcChannels.cockpit.terminalStop, request),
  onEvent: (cb: (event: CockpitEvent) => void) =>
    subscribe<CockpitEvent>(IpcChannels.cockpit.event, cb)
};

function subscribe<T>(channel: string, cb: (event: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const vaultApi: VaultApi = {
  list: (request) => ipcRenderer.invoke(IpcChannels.vault.list, request),
  save: (request) => ipcRenderer.invoke(IpcChannels.vault.save, request),
  update: (request) => ipcRenderer.invoke(IpcChannels.vault.update, request),
  delete: (request) => ipcRenderer.invoke(IpcChannels.vault.delete, request),
  getSecret: (request) => ipcRenderer.invoke(IpcChannels.vault.getSecret, request),
  onChange: (cb) => subscribe<VaultChangeEvent>(IpcChannels.vault.change, cb)
};

api.window = windowApi;
api.browser = browserApi;
if (!tailscaleSession) api.vault = vaultApi;
api.connections = connectionsApi;
api.cockpit = cockpitApi;
contextBridge.exposeInMainWorld('soloe', api);

ipcRenderer.on(
  'soloe:webview-zoom-key',
  (_event: IpcRendererEvent, payload: { direction: 'in' | 'out' | 'reset' }) => {
    window.dispatchEvent(
      new CustomEvent('soloe:browser-zoom', { detail: { direction: payload.direction } })
    );
  }
);

ipcRenderer.on('soloe:webview-toggle-devtools', () => {
  window.dispatchEvent(new CustomEvent('soloe:browser-toggle-devtools'));
});

ipcRenderer.on('soloe:webview-restore-tab', () => {
  window.dispatchEvent(new CustomEvent('soloe:browser-restore-tab'));
});
