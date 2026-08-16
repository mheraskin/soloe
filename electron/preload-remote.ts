import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannels,
  type BrowserApi,
  type ConnectionsApi,
  type VaultApi,
  type WindowApi
} from '@shared/types/ipc.js';
import type { ConnectionSnapshot } from '@shared/types/connections.js';
import type {
  CreateMultiDeviceSessionRequest,
  MultiDeviceSessionState
} from '@shared/types/multi-device-sessions.js';
import type { DeviceEventEnvelope, SessionRef, TerminalRef } from '@shared/types/devices.js';
import type { TerminalControlProof } from '@shared/types/terminal.js';
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
  configure: (patch) => ipcRenderer.invoke(IpcChannels.connections.configure, patch),
  add: (request) => ipcRenderer.invoke(IpcChannels.connections.add, request),
  remove: (id) => ipcRenderer.invoke(IpcChannels.connections.remove, id),
  setEnabled: (id, enabled) => ipcRenderer.invoke(IpcChannels.connections.enable, id, enabled),
  select: (id) => ipcRenderer.invoke(IpcChannels.connections.select, id),
  onChange: (cb) => subscribe<ConnectionSnapshot>(IpcChannels.connections.change, cb)
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
api.sessions.deviceState = () => ipcRenderer.invoke(IpcChannels.sessions.deviceState);
api.sessions.refreshDevices = () => ipcRenderer.invoke(IpcChannels.sessions.refreshDevices);
api.sessions.reorderOnDevices = (refs: SessionRef[]) =>
  ipcRenderer.invoke(IpcChannels.sessions.reorderOnDevices, refs);
api.sessions.createOnDevice = (request: CreateMultiDeviceSessionRequest) =>
  ipcRenderer.invoke(IpcChannels.sessions.createOnDevice, request);
api.sessions.planCreateOnDevice = (request: CreateMultiDeviceSessionRequest) =>
  ipcRenderer.invoke(IpcChannels.sessions.planCreateOnDevice, request);
api.sessions.executeCreateOnDevice = (planId: string) =>
  ipcRenderer.invoke(IpcChannels.sessions.executeCreateOnDevice, planId);
api.sessions.browseDeviceWorkspaceDirectories = (request) =>
  ipcRenderer.invoke(IpcChannels.sessions.browseDeviceWorkspaceDirectories, request);
api.sessions.openProjectOnDevice = (request) =>
  ipcRenderer.invoke(IpcChannels.sessions.openProjectOnDevice, request);
api.sessions.executeDevicePreparation = (planId) =>
  ipcRenderer.invoke(IpcChannels.sessions.executeDevicePreparation, planId);
api.sessions.startOnDevice = (ref: SessionRef) =>
  ipcRenderer.invoke(IpcChannels.sessions.startOnDevice, ref);
api.sessions.updateOnDevice = (request) =>
  ipcRenderer.invoke(IpcChannels.sessions.updateOnDevice, request);
api.sessions.deleteOnDevice = (ref: SessionRef) =>
  ipcRenderer.invoke(IpcChannels.sessions.deleteOnDevice, ref);
api.sessions.previewCommandOnDevice = (ref: SessionRef) =>
  ipcRenderer.invoke(IpcChannels.sessions.previewCommandOnDevice, ref);
api.sessions.setDeviceTerminalDemand = (refs: TerminalRef[]) =>
  ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalDemand, refs);
api.sessions.deviceTerminalInput = (request: {
  ref: TerminalRef;
  data: string;
  control: TerminalControlProof;
}) =>
  ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalInput, request);
api.sessions.deviceTerminalInputLease = (request: { ref: TerminalRef; takeover?: boolean }) =>
  ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalInputLease, request);
api.sessions.deviceTerminalCurrentInputLease = (ref: TerminalRef) =>
  ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalCurrentInputLease, ref);
api.sessions.deviceTerminalReleaseInputLease = (request: {
  ref: TerminalRef;
  control: TerminalControlProof;
}) =>
  ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalReleaseInputLease, request);
api.sessions.deviceTerminalResize = (request: {
  ref: TerminalRef;
  cols: number;
  rows: number;
  control: TerminalControlProof;
}) =>
  ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalResize, request);
api.sessions.deviceTerminalReplay = (ref: TerminalRef, afterSeq?: number) =>
  ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalReplay, ref, afterSeq);
api.sessions.deviceTerminalStop = (ref: TerminalRef) =>
  ipcRenderer.invoke(IpcChannels.sessions.deviceTerminalStop, ref);
api.sessions.onDeviceStateChange = (cb: (state: MultiDeviceSessionState) => void) =>
  subscribe<MultiDeviceSessionState>(IpcChannels.sessions.deviceStateChanged, cb);
api.sessions.onDeviceEvent = (cb: (event: DeviceEventEnvelope) => void) =>
  subscribe<DeviceEventEnvelope>(IpcChannels.sessions.deviceEvent, cb);
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
