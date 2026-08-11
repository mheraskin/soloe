import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { FeaturesIpc } from './features.ipc.js';

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
});

describe('FeaturesIpc subscription ownership', () => {
  it('keeps subscriptions isolated per renderer and releases them on destruction', async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const observation = {
      acquire: vi.fn(() => {
        const release = vi.fn();
        releases.push(release);
        return release;
      }),
      onChange: vi.fn(() => vi.fn())
    };
    const ipc = new FeaturesIpc({
      service: {} as never,
      observation: observation as never
    });
    ipc.register();
    const request = { cwd: '/repo', runMode: 'windows' as const };
    const first = new FakeSender(1);
    const second = new FakeSender(2);

    await invoke(IpcChannels.features.subscribe, first, request);
    await invoke(IpcChannels.features.subscribe, second, request);
    expect(observation.acquire).toHaveBeenCalledTimes(2);

    await invoke(IpcChannels.features.unsubscribe, first, request);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).not.toHaveBeenCalled();

    second.destroy();
    expect(releases[1]).toHaveBeenCalledTimes(1);
    ipc.dispose();
  });

  it('replaces only the same renderer ownership when it re-subscribes', async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const observation = {
      acquire: vi.fn(() => {
        const release = vi.fn();
        releases.push(release);
        return release;
      }),
      onChange: vi.fn(() => vi.fn())
    };
    const ipc = new FeaturesIpc({
      service: {} as never,
      observation: observation as never
    });
    ipc.register();
    const sender = new FakeSender(7);
    const request = { cwd: '/repo', runMode: 'windows' as const };

    await invoke(IpcChannels.features.subscribe, sender, request);
    await invoke(IpcChannels.features.subscribe, sender, request);

    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).not.toHaveBeenCalled();
    ipc.dispose();
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });

  it('publishes changes only to renderers subscribed to the exact Worktree Identity', async () => {
    let publish!: (event: {
      cwd: string;
      runMode: 'windows' | 'wsl';
      wslDistro?: string;
      kind: 'features';
      revision: string;
    }) => void;
    const observation = {
      acquire: vi.fn(() => vi.fn()),
      onChange: vi.fn((listener: typeof publish) => {
        publish = listener;
        return vi.fn();
      })
    };
    const ipc = new FeaturesIpc({
      service: {} as never,
      observation: observation as never
    });
    ipc.register();
    const ubuntu = new FakeSender(11);
    const debian = new FakeSender(12);
    const other = new FakeSender(13);
    await invoke(IpcChannels.features.subscribe, ubuntu, {
      cwd: '/repo',
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    await invoke(IpcChannels.features.subscribe, debian, {
      cwd: '/repo',
      runMode: 'wsl',
      wslDistro: 'Debian'
    });
    await invoke(IpcChannels.features.subscribe, other, {
      cwd: '/other',
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });

    const event = {
      cwd: '/repo',
      runMode: 'wsl' as const,
      wslDistro: 'Ubuntu',
      kind: 'features' as const,
      revision: 'revision-1'
    };
    publish(event);

    expect(ubuntu.send).toHaveBeenCalledWith(IpcChannels.features.change, event);
    expect(debian.send).not.toHaveBeenCalled();
    expect(other.send).not.toHaveBeenCalled();
    ipc.dispose();
  });
});

class FakeSender extends EventEmitter {
  private destroyed = false;
  readonly send = vi.fn();

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

async function invoke(channel: string, sender: FakeSender, request: unknown): Promise<void> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  await handler({ sender } as never, request as never);
}
