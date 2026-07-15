import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  removeHandler: vi.fn()
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: electronMocks.removeHandler
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import type { GitService } from '../git/GitService.js';
import { GitIpc } from './git.ipc.js';

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
});

describe('GitIpc observation demand', () => {
  it('coalesces repeated demand from one renderer and releases the final lease', async () => {
    const release = vi.fn();
    const acquireObservation = vi.fn(async () => release);
    const ipc = createIpc(acquireObservation);
    const owner = new FakeWebContents(1);

    await demand(owner, '/repo', true);
    await demand(owner, '/repo', true);
    expect(acquireObservation).toHaveBeenCalledOnce();

    await demand(owner, '/repo', false);
    expect(release).toHaveBeenCalledOnce();
    ipc.dispose();
  });

  it('keeps runtime-qualified demand independent', async () => {
    const releases = [vi.fn(), vi.fn()];
    const allReleases = [...releases];
    const acquireObservation = vi.fn(async () => releases.shift()!);
    const ipc = createIpc(acquireObservation);
    const owner = new FakeWebContents(1);

    await demand(owner, '/repo', true, 'Ubuntu');
    await demand(owner, '/repo', true, 'Debian');
    expect(acquireObservation).toHaveBeenCalledTimes(2);

    await demand(owner, '/repo', false, 'Ubuntu');
    expect(allReleases[0]).toHaveBeenCalledOnce();
    expect(allReleases[1]).not.toHaveBeenCalled();
    ipc.dispose();
    expect(allReleases[1]).toHaveBeenCalledOnce();
  });

  it('releases an acquisition that completes after demand was withdrawn', async () => {
    let resolveAcquire!: (release: () => void) => void;
    const release = vi.fn();
    const acquireObservation = vi.fn(() => new Promise<() => void>((resolve) => {
      resolveAcquire = resolve;
    }));
    const ipc = createIpc(acquireObservation);
    const owner = new FakeWebContents(1);

    const acquiring = demand(owner, '/repo', true);
    await demand(owner, '/repo', false);
    resolveAcquire(release);
    await acquiring;

    expect(release).toHaveBeenCalledOnce();
    ipc.dispose();
  });

  it('releases every observation lease when its renderer is destroyed', async () => {
    const releases = [vi.fn(), vi.fn()];
    const allReleases = [...releases];
    const acquireObservation = vi.fn(async () => releases.shift()!);
    const ipc = createIpc(acquireObservation);
    const owner = new FakeWebContents(1);

    await demand(owner, '/one', true);
    await demand(owner, '/two', true);
    owner.emit('destroyed');

    expect(allReleases.every((release) => release.mock.calls.length === 1)).toBe(true);
    ipc.dispose();
  });
});

function createIpc(acquireObservation: (...args: any[]) => Promise<() => void>): GitIpc {
  const service = {
    acquireObservation,
    onChange: vi.fn(() => vi.fn())
  } as unknown as GitService;
  const ipc = new GitIpc({ service, getWindows: () => [] });
  ipc.register();
  return ipc;
}

async function demand(
  sender: FakeWebContents,
  cwd: string,
  active: boolean,
  wslDistro?: string
): Promise<void> {
  const handler = electronMocks.handlers.get(IpcChannels.git.observationDemand);
  if (!handler) throw new Error('observation demand handler not registered');
  const request = {
    cwd,
    active,
    ...(wslDistro ? { runMode: 'wsl' as const, wslDistro } : {})
  };
  await expect(handler({ sender }, request)).resolves.toEqual({ ok: true, value: true });
}
