import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, type BrowserApi, type WindowApi } from '@shared/types/ipc.js';
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

api.window = windowApi;
api.browser = browserApi;
contextBridge.exposeInMainWorld('soloe', api);

ipcRenderer.on(
  'soloe:webview-zoom-key',
  (_event: IpcRendererEvent, payload: { direction: 'in' | 'out' | 'reset' }) => {
    window.dispatchEvent(
      new CustomEvent('soloe:browser-zoom', { detail: { direction: payload.direction } })
    );
  }
);
