import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_ELECTRON_NATIVE_METHODS,
  SOLOE_API_METHODS
} from '@shared/api-contract.js';
import { IpcChannels, type SoloeApi } from '@shared/types/ipc.js';

const mocks = vi.hoisted(() => ({
  createBrowserApi: vi.fn(),
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn()
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mocks.exposeInMainWorld
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.on,
    off: mocks.off
  }
}));

vi.mock('../src/lib/browser-api.js', () => ({
  createBrowserApi: mocks.createBrowserApi
}));

const previousServerUrl = process.env.SOLOE_CLIENT_SERVER_URL;
const previousServerToken = process.env.SOLOE_SERVER_TOKEN;

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (previousServerUrl === undefined) delete process.env.SOLOE_CLIENT_SERVER_URL;
  else process.env.SOLOE_CLIENT_SERVER_URL = previousServerUrl;
  if (previousServerToken === undefined) delete process.env.SOLOE_SERVER_TOKEN;
  else process.env.SOLOE_SERVER_TOKEN = previousServerToken;
});

describe('remote Electron preload', () => {
  it('keeps every backend namespace server-backed and overrides only native Electron APIs', async () => {
    process.env.SOLOE_CLIENT_SERVER_URL = 'http://127.0.0.1:43891';
    process.env.SOLOE_SERVER_TOKEN = 'remote-test-token';

    const serverNamespaces = Object.fromEntries(
      Object.keys(SOLOE_API_METHODS).map((namespace) => [
        namespace,
        { transportMarker: `server:${namespace}` }
      ])
    ) as unknown as SoloeApi;
    const originalNamespaces = Object.fromEntries(
      Object.entries(serverNamespaces).map(([namespace, api]) => [namespace, api])
    );
    mocks.createBrowserApi.mockReturnValue(serverNamespaces);

    await import('./preload-remote.js');

    expect(mocks.createBrowserApi).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:43891',
      transport: 'remote-electron',
      token: 'remote-test-token'
    });
    expect(mocks.exposeInMainWorld).toHaveBeenCalledOnce();
    expect(mocks.exposeInMainWorld.mock.calls[0]?.[0]).toBe('soloe');

    const exposed = mocks.exposeInMainWorld.mock.calls[0]?.[1] as SoloeApi;
    for (const namespace of Object.keys(SOLOE_API_METHODS)) {
      if (namespace === 'window' || namespace === 'browser') continue;
      expect(exposed[namespace as keyof SoloeApi], namespace).toBe(originalNamespaces[namespace]);
    }
    expect(exposed.window).not.toBe(originalNamespaces.window);
    expect(exposed.browser).not.toBe(originalNamespaces.browser);

    await exposed.window.minimize();
    await exposed.window.toggleMaximize();
    await exposed.window.zoomIn();
    await exposed.window.zoomOut();
    await exposed.window.close();
    await exposed.browser.enableDeviceEmulation({
      webContentsId: 1,
      emulation: {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true
      }
    });
    await exposed.browser.disableDeviceEmulation({ webContentsId: 1 });
    await exposed.browser.setUserAgent({ webContentsId: 1, userAgent: 'remote-test' });
    await exposed.browser.openDevTools({
      webContentsId: 1,
      bounds: { x: 900, y: 0, width: 540, height: 844 }
    });
    await exposed.browser.setDevToolsLayout({
      webContentsId: 1,
      bounds: { x: 900, y: 0, width: 540, height: 844 },
      visible: true
    });
    await exposed.browser.closeDevTools({ webContentsId: 1 });

    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      IpcChannels.window.minimize,
      IpcChannels.window.toggleMaximize,
      IpcChannels.window.zoomIn,
      IpcChannels.window.zoomOut,
      IpcChannels.window.close,
      IpcChannels.browser.enableDeviceEmulation,
      IpcChannels.browser.disableDeviceEmulation,
      IpcChannels.browser.setUserAgent,
      IpcChannels.browser.openDevTools,
      IpcChannels.browser.setDevToolsLayout,
      IpcChannels.browser.closeDevTools
    ]);
    expect(REMOTE_ELECTRON_NATIVE_METHODS).toEqual(new Set([
      ...SOLOE_API_METHODS.window.map((method) => `window.${method}`),
      ...SOLOE_API_METHODS.browser.map((method) => `browser.${method}`)
    ]));
  });
});
