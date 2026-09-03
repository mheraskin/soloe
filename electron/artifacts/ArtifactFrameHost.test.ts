import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  protocolHandlers: new Map<string, (request: { url: string }) => Response>(),
  registerSchemesAsPrivileged: vi.fn(),
  removeHandler: vi.fn(),
  unhandle: vi.fn()
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.ipcHandlers.set(channel, handler);
    },
    removeHandler: mocks.removeHandler
  },
  protocol: {
    handle: (scheme: string, handler: (request: { url: string }) => Response) => {
      mocks.protocolHandlers.set(scheme, handler);
    },
    registerSchemesAsPrivileged: mocks.registerSchemesAsPrivileged,
    unhandle: mocks.unhandle
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import {
  ArtifactFrameHost,
  registerArtifactFrameScheme
} from './ArtifactFrameHost.js';

beforeEach(() => {
  mocks.ipcHandlers.clear();
  mocks.protocolHandlers.clear();
  vi.clearAllMocks();
});

describe('ArtifactFrameHost', () => {
  it('serves prepared HTML through the isolated Electron protocol', async () => {
    registerArtifactFrameScheme();
    const host = new ArtifactFrameHost();
    host.register();
    const prepare = mocks.ipcHandlers.get(IpcChannels.artifacts.prepareFrame);
    if (!prepare) throw new Error('Artifact frame IPC handler was not registered');

    const result = await prepare({}, '<script>parent.postMessage("ready", "*")</script>');
    expect(result).toMatchObject({
      ok: true,
      value: { url: expect.stringMatching(/^soloe-artifact:\/\/frame\//u) }
    });
    if (!result || typeof result !== 'object' || !('value' in result)) {
      throw new Error('Artifact frame IPC result was invalid');
    }
    const value = result.value;
    if (!value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string') {
      throw new Error('Artifact frame URL was invalid');
    }
    const handle = mocks.protocolHandlers.get('soloe-artifact');
    if (!handle) throw new Error('Artifact frame protocol handler was not registered');

    const response = handle({ url: value.url });

    expect(await response.text()).toBe(
      '<script>parent.postMessage("ready", "*")</script>'
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'unsafe-inline'"
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "connect-src 'none'"
    );
    expect(mocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: 'soloe-artifact' })
    ]);

    host.dispose();
    expect(mocks.removeHandler).toHaveBeenCalledWith(IpcChannels.artifacts.prepareFrame);
    expect(mocks.unhandle).toHaveBeenCalledWith('soloe-artifact');
  });
});
