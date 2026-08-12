import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { BrowserApi, IpcResult, WindowApi } from '@shared/types/ipc.js';
import { createBrowserApi } from './browser-api';
import { setRendererZoom } from './native-surface-layout';

interface TauriBackendBootstrap {
  address: string;
  token: string;
}

declare global {
  interface Window {
    __SOLOE_TAURI_BACKEND__?: TauriBackendBootstrap | null;
  }
}

let rendererZoom = 1;

function result(operation: () => void | Promise<void>): Promise<IpcResult<true>> {
  return Promise.resolve()
    .then(operation)
    .then(() => ({ ok: true as const, value: true as const }))
    .catch((error) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error)
    }));
}

function zoom(delta: number): Promise<IpcResult<number>> {
  const next = Math.max(0.5, Math.min(2, Math.round((rendererZoom + delta) * 10) / 10));
  return getCurrentWebview().setZoom(next)
    .then(() => {
      rendererZoom = next;
      setRendererZoom(next);
      return { ok: true as const, value: rendererZoom };
    })
    .catch((error) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error)
    }));
}

const windowClient: WindowApi = {
  minimize: () => result(() => getCurrentWindow().minimize()),
  toggleMaximize: () => result(() => getCurrentWindow().toggleMaximize()),
  zoomIn: () => zoom(0.1),
  zoomOut: () => zoom(-0.1),
  close: () => result(() => getCurrentWindow().close())
};

const browserClient: BrowserApi = {
  enableDeviceEmulation: (request) =>
    invoke('browser_enable_device_emulation', { request }),
  disableDeviceEmulation: (request) =>
    invoke('browser_disable_device_emulation', { request }),
  setUserAgent: (request) => invoke('browser_set_user_agent', { request }),
  openDevTools: (request) => invoke('browser_open_dev_tools', { request }),
  setDevToolsLayout: (request) => invoke('browser_set_dev_tools_layout', { request }),
  closeDevTools: (request) => invoke('browser_close_dev_tools', { request })
};

export function isTauriRenderer(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function installTauriApi(): void {
  if (window.soloe) return;
  const backend = window.__SOLOE_TAURI_BACKEND__;
  window.soloe = createBrowserApi({
    transport: 'tauri',
    ...(backend ? { baseUrl: backend.address, token: backend.token } : {}),
    windowClient,
    browserClient,
    openExternalClient: (url) => invoke('open_external', { url })
  });
}
