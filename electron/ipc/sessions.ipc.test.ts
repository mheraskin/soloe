import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/types/sessions.js';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  removeHandler: vi.fn()
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: electronMocks.removeHandler
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import { SessionsIpc } from './sessions.ipc.js';

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
});

describe('SessionsIpc lifecycle broadcasts', () => {
  it('broadcasts create, update, reorder, and delete mutations to every live window', async () => {
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    const destroyedSend = vi.fn();
    const created = session('created', 0);
    const updated = { ...created, name: 'Updated' };
    const reordered = [session('second', 0), { ...updated, sortIndex: 1 }];
    const onInventoryChanged = vi.fn();
    const store = {
      create: vi.fn(async () => created),
      update: vi.fn(async () => updated),
      delete: vi.fn(async () => undefined),
      reorder: vi.fn(async () => reordered)
    };
    const ipc = new SessionsIpc({
      store: store as never,
      commandBuilder: {} as never,
      onInventoryChanged,
      getWindows: () => [
        window(firstSend, false),
        window(secondSend, false),
        window(destroyedSend, true)
      ] as never
    });
    ipc.register();

    await invoke(IpcChannels.sessions.create, {
      name: 'Created',
      cwd: '/repo',
      runMode: 'linux',
      launch: { type: 'terminal', shell: 'auto' }
    });
    await invoke(IpcChannels.sessions.update, created.id, { name: 'Updated' });
    await invoke(IpcChannels.sessions.reorder, reordered.map((item) => item.id));
    await invoke(IpcChannels.sessions.delete, created.id);

    for (const send of [firstSend, secondSend]) {
      expect(send).toHaveBeenCalledWith(IpcChannels.sessions.changed, created);
      expect(send).toHaveBeenCalledWith(IpcChannels.sessions.changed, updated);
      expect(send).toHaveBeenCalledWith(IpcChannels.sessions.changed, reordered[0]);
      expect(send).toHaveBeenCalledWith(IpcChannels.sessions.deleted, created.id);
    }
    expect(destroyedSend).not.toHaveBeenCalled();
    expect(onInventoryChanged).toHaveBeenCalledTimes(4);
    ipc.dispose();
  });
});

function session(id: string, sortIndex: number): Session {
  return {
    id,
    name: id,
    cwd: '/repo',
    runMode: 'linux',
    launch: { type: 'terminal', shell: 'auto' },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    sortIndex
  };
}

function window(send: ReturnType<typeof vi.fn>, destroyed: boolean) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send }
  };
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler({ sender: {} } as never, ...args as never[]);
}
