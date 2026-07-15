/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/types/sessions.js';

const { off, listener, inventoryOff, onWorktrees, projectGet, loadWorktrees } = vi.hoisted(() => {
  const detach = vi.fn();
  const detachInventory = vi.fn();
  return {
    off: detach,
    listener: vi.fn(() => detach),
    inventoryOff: detachInventory,
    onWorktrees: vi.fn(() => detachInventory),
    projectGet: vi.fn(() => null as { path: string } | null),
    loadWorktrees: vi.fn(async () => [] as Array<{ path: string }>)
  };
});

vi.mock('../lib/ipc', () => ({
  ipc: {
    terminal: {
      onStatus: listener,
      onExit: listener,
      onLocation: listener
    },
    observer: {
      onSnapshot: listener,
      onEvent: listener
    },
    notify: {
      onActivateSession: listener
    },
    sessions: {
      onChange: listener
    }
  }
}));

vi.mock('./projects.svelte', () => ({
  projects: { get: projectGet }
}));

vi.mock('./git.svelte', () => ({
  git: { loadWorktrees, onWorktrees }
}));

vi.mock('./settings.svelte', () => ({
  settings: { current: {} }
}));

vi.mock('./agent-notifications.svelte', () => ({
  agentNotifications: {
    observeSnapshot: vi.fn(),
    observeEvent: vi.fn()
  },
  rowSessionIdFor: vi.fn(() => null)
}));

vi.mock('./right-rail.svelte', () => ({
  rightRail: {}
}));

import { SessionsStore } from './sessions.svelte';

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('SessionsStore worktree sweep lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listener.mockClear();
    off.mockClear();
    inventoryOff.mockClear();
    onWorktrees.mockClear();
    projectGet.mockReset();
    projectGet.mockReturnValue(null);
    loadWorktrees.mockReset();
    loadWorktrees.mockResolvedValue([]);
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses inventory events without allocating a periodic sweep timer', () => {
    const store = new SessionsStore();
    store.attachListeners();
    expect(onWorktrees).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    setVisibility('hidden');
    expect(vi.getTimerCount()).toBe(0);

    setVisibility('visible');
    expect(vi.getTimerCount()).toBe(0);

    store.detach();
  });

  it('does not leave a timer or visibility listener behind after detach', () => {
    const store = new SessionsStore();
    store.attachListeners();
    store.detach();
    expect(vi.getTimerCount()).toBe(0);
    expect(inventoryOff).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a sweep when attached in a hidden window', () => {
    setVisibility('hidden');
    const store = new SessionsStore();
    store.attachListeners();
    expect(vi.getTimerCount()).toBe(0);
    store.detach();
  });

  it('archives the only session when its worktree was removed', async () => {
    const store = new SessionsStore();
    store.sessions = [session({ id: 'orphan', cwd: '/repo/removed' })];
    projectGet.mockReturnValue({ path: '/repo' });
    loadWorktrees.mockResolvedValue([{ path: '/repo' }]);
    const archive = vi.spyOn(store, 'archive').mockResolvedValue();

    store.attachListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(archive).toHaveBeenCalledWith('orphan');
    store.detach();
  });

  it('does not archive Windows spelling variants of the same Worktree', async () => {
    const store = new SessionsStore();
    store.sessions = [session({ cwd: 'C:\\Code\\Repo' })];
    projectGet.mockReturnValue({ path: 'C:\\Code\\Repo' });
    loadWorktrees.mockResolvedValue([{ path: 'c:/code/repo/' }]);
    const archive = vi.spyOn(store, 'archive').mockResolvedValue();

    store.attachListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(archive).not.toHaveBeenCalled();
    store.detach();
  });

  it('treats an empty Worktree inventory as inconclusive', async () => {
    const store = new SessionsStore();
    store.sessions = [session({ cwd: '/repo/maybe-unreachable', runMode: 'wsl' })];
    projectGet.mockReturnValue({ path: '/repo' });
    loadWorktrees.mockResolvedValue([]);
    const archive = vi.spyOn(store, 'archive').mockResolvedValue();

    store.attachListeners();
    await vi.advanceTimersByTimeAsync(0);

    expect(archive).not.toHaveBeenCalled();
    store.detach();
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session',
    launch: { type: 'terminal', shell: 'auto' },
    name: 'Session',
    cwd: '/repo/worktree',
    runMode: 'windows',
    projectId: 'project',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}
