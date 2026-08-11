import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcChannels,
  type BrowserApi,
  type VaultApi,
  type WindowApi
} from '@shared/types/ipc.js';
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

const api = createBrowserApi({
  baseUrl: serverUrl,
  transport: 'remote-electron',
  ...(process.env.SOLOE_SERVER_TOKEN
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
api.vault = vaultApi;
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
