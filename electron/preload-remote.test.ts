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
const previousTailscaleSession = process.env.SOLOE_CLIENT_TAILSCALE_SESSION;

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (previousServerUrl === undefined) delete process.env.SOLOE_CLIENT_SERVER_URL;
  else process.env.SOLOE_CLIENT_SERVER_URL = previousServerUrl;
  if (previousServerToken === undefined) delete process.env.SOLOE_SERVER_TOKEN;
  else process.env.SOLOE_SERVER_TOKEN = previousServerToken;
  if (previousTailscaleSession === undefined) delete process.env.SOLOE_CLIENT_TAILSCALE_SESSION;
  else process.env.SOLOE_CLIENT_TAILSCALE_SESSION = previousTailscaleSession;
});

describe('remote Electron preload', () => {
  it('keeps host-encrypted vault operations local to Electron', async () => {
    delete process.env.SOLOE_CLIENT_TAILSCALE_SESSION;
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
      if (
        namespace === 'window'
        || namespace === 'browser'
        || namespace === 'vault'
      ) continue;
      expect(exposed[namespace as keyof SoloeApi], namespace).toBe(originalNamespaces[namespace]);
    }
    expect(exposed.window).not.toBe(originalNamespaces.window);
    expect(exposed.browser).not.toBe(originalNamespaces.browser);
    expect(exposed.vault).not.toBe(originalNamespaces.vault);
    expect(exposed.connections).toBe(originalNamespaces.connections);

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
        mobile: true,
        scale: 1
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
    await exposed.vault.getSecret({ cwd: 'C:\\repo', id: '0123456789abcdef' });

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
      IpcChannels.browser.closeDevTools,
      IpcChannels.vault.getSecret
    ]);
    expect(REMOTE_ELECTRON_NATIVE_METHODS).toEqual(new Set([
      ...SOLOE_API_METHODS.window.map((method) => `window.${method}`),
      ...SOLOE_API_METHODS.browser.map((method) => `browser.${method}`),
      ...SOLOE_API_METHODS.vault.map((method) => `vault.${method}`)
    ]));
  });

  it('keeps a Tailscale device vault on the selected remote machine', async () => {
    process.env.SOLOE_CLIENT_SERVER_URL = 'https://alpha.tail1234.ts.net';
    process.env.SOLOE_SERVER_TOKEN = 'must-not-cross-the-tailnet';
    process.env.SOLOE_CLIENT_TAILSCALE_SESSION = '1';
    const serverNamespaces = Object.fromEntries(
      Object.keys(SOLOE_API_METHODS).map((namespace) => [
        namespace,
        { transportMarker: `server:${namespace}` }
      ])
    ) as unknown as SoloeApi;
    const remoteVault = serverNamespaces.vault;
    const unsupportedConnections = serverNamespaces.connections;
    mocks.createBrowserApi.mockReturnValue(serverNamespaces);

    await import('./preload-remote.js');

    expect(mocks.createBrowserApi).toHaveBeenCalledWith({
      baseUrl: 'https://alpha.tail1234.ts.net',
      transport: 'browser'
    });
    const exposed = mocks.exposeInMainWorld.mock.calls[0]?.[1] as SoloeApi;
    expect(exposed.vault).toBe(remoteVault);
    expect(exposed.connections).toBe(unsupportedConnections);
  });

  it('keeps owner-routed Session mutations on the server transport', async () => {
    delete process.env.SOLOE_CLIENT_TAILSCALE_SESSION;
    process.env.SOLOE_CLIENT_SERVER_URL = 'http://127.0.0.1:43891';
    process.env.SOLOE_SERVER_TOKEN = 'remote-test-token';
    const serverApi = Object.fromEntries(
      Object.keys(SOLOE_API_METHODS).map((namespace) => [namespace, {}])
    ) as unknown as SoloeApi;
    const updateOnDevice = vi.fn();
    const deleteOnDevice = vi.fn();
    const previewCommandOnDevice = vi.fn();
    serverApi.sessions = {
      ...serverApi.sessions,
      updateOnDevice,
      deleteOnDevice,
      previewCommandOnDevice
    };
    mocks.createBrowserApi.mockReturnValue(serverApi);

    await import('./preload-remote.js');

    const exposed = mocks.exposeInMainWorld.mock.calls[0]?.[1] as SoloeApi;
    const ref = { deviceId: 'device-alpha', sessionId: 'session-1' };
    const patch = { name: 'Renamed remotely' };

    await exposed.sessions.updateOnDevice?.({ ref, patch });
    await exposed.sessions.deleteOnDevice?.(ref);
    await exposed.sessions.previewCommandOnDevice?.(ref);

    expect(updateOnDevice).toHaveBeenCalledWith({ ref, patch });
    expect(deleteOnDevice).toHaveBeenCalledWith(ref);
    expect(previewCommandOnDevice).toHaveBeenCalledWith(ref);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
