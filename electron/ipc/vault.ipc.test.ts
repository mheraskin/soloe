import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import { VaultIpc } from './vault.ipc.js';

describe('VaultIpc', () => {
  beforeEach(() => handlers.clear());

  it('does not initialize secure storage until the Vault is first used', async () => {
    const store = {
      list: vi.fn(async () => []),
      save: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getSecret: vi.fn(),
      onChange: vi.fn(() => vi.fn())
    };
    const createStore = vi.fn(async () => store);
    const ipc = new VaultIpc({
      createStore,
      getWindows: () => []
    });

    ipc.register();
    expect(createStore).not.toHaveBeenCalled();

    const list = handlers.get(IpcChannels.vault.list);
    expect(list).toBeDefined();
    await list?.({}, { cwd: '/tmp/project' });

    expect(createStore).toHaveBeenCalledOnce();
    expect(store.list).toHaveBeenCalledWith('/tmp/project');
  });
});
