/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/types/sessions.js';
import type {
  TerminalExitEvent,
  TerminalLocationEvent,
  TerminalStartResult,
  TerminalStatusEvent
} from '@shared/types/terminal.js';

const {
  off,
  listener,
  terminalStart,
  terminalStatusListeners,
  terminalExitListeners,
  terminalLocationListeners,
  inventoryOff,
  onWorktrees,
  projectGet,
  loadWorktrees,
  sessionCreate,
  sessionList,
  sessionListArchived,
  sessionChanges,
  sessionChangeListener,
  sessionDeletes,
  sessionDeleteListener,
  connectionReconnects,
  connectionReconnectListener,
  terminalListRunning,
  observerList,
  observerListEvents
} = vi.hoisted(() => {
  const detach = vi.fn();
  const detachInventory = vi.fn();
  const changes = {
    emit: (_session: unknown): void => {}
  };
  const deletes = {
    emit: (_sessionId: string): void => {}
  };
  const reconnects = {
    emit: (): void => {}
  };
  return {
    off: detach,
    listener: vi.fn(() => detach),
    terminalStart: vi.fn(),
    terminalStatusListeners: [] as Array<(event: TerminalStatusEvent) => void>,
    terminalExitListeners: [] as Array<(event: TerminalExitEvent) => void>,
    terminalLocationListeners: [] as Array<(event: TerminalLocationEvent) => void>,
    inventoryOff: detachInventory,
    onWorktrees: vi.fn(() => detachInventory),
    projectGet: vi.fn(() => null as { path: string } | null),
    loadWorktrees: vi.fn(async () => [] as Array<{ path: string }>),
    sessionCreate: vi.fn(),
    sessionList: vi.fn(),
    sessionListArchived: vi.fn(),
    sessionChanges: changes,
    sessionChangeListener: vi.fn((cb: (session: unknown) => void) => {
      changes.emit = cb;
      return detach;
    }),
    sessionDeletes: deletes,
    sessionDeleteListener: vi.fn((cb: (sessionId: string) => void) => {
      deletes.emit = cb;
      return detach;
    }),
    connectionReconnects: reconnects,
    connectionReconnectListener: vi.fn((cb: () => void) => {
      reconnects.emit = cb;
      return detach;
    }),
    terminalListRunning: vi.fn(),
    observerList: vi.fn(),
    observerListEvents: vi.fn()
  };
});

vi.mock('../lib/ipc', () => ({
  ipc: {
    terminal: {
      start: terminalStart,
      onStatus: vi.fn((callback: (event: TerminalStatusEvent) => void) => {
        terminalStatusListeners.push(callback);
        return off;
      }),
      onExit: vi.fn((callback: (event: TerminalExitEvent) => void) => {
        terminalExitListeners.push(callback);
        return off;
      }),
      onLocation: vi.fn((callback: (event: TerminalLocationEvent) => void) => {
        terminalLocationListeners.push(callback);
        return off;
      }),
      listRunning: terminalListRunning
    },
    observer: {
      onSnapshot: listener,
      onEvent: listener,
      list: observerList,
      listEvents: observerListEvents
    },
    notify: {
      onActivateSession: listener
    },
    sessions: {
      create: sessionCreate,
      list: sessionList,
      listArchived: sessionListArchived,
      onChange: sessionChangeListener,
      onDelete: sessionDeleteListener
    },
    connection: {
      onReconnect: connectionReconnectListener
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
    observeEvent: vi.fn(),
    markSessionOpened: vi.fn(),
    primeSnapshot: vi.fn(),
    removeSession: vi.fn()
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

describe('SessionsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listener.mockClear();
    terminalStart.mockReset();
    terminalStatusListeners.length = 0;
    terminalExitListeners.length = 0;
    terminalLocationListeners.length = 0;
    off.mockClear();
    inventoryOff.mockClear();
    onWorktrees.mockClear();
    projectGet.mockReset();
    projectGet.mockReturnValue(null);
    loadWorktrees.mockReset();
    loadWorktrees.mockResolvedValue([]);
    sessionList.mockReset();
    sessionList.mockResolvedValue([]);
    sessionListArchived.mockReset();
    sessionListArchived.mockResolvedValue([]);
    terminalListRunning.mockReset();
    terminalListRunning.mockResolvedValue([]);
    observerList.mockReset();
    observerList.mockResolvedValue([]);
    observerListEvents.mockReset();
    observerListEvents.mockResolvedValue([]);
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

  it('stays resumable when the backend rejects a duplicate start', async () => {
    const store = new SessionsStore();
    store.sessions = [session()];
    store.runtime = {
      session: {
        sessionId: 'session',
        terminalId: null,
        status: 'exited',
        exitCode: 0
      }
    };
    terminalStart.mockRejectedValueOnce(new Error('Session session is already running'));

    await expect(store.start('session', { focus: false })).rejects.toThrow(
      'Session session is already running'
    );

    expect(store.runtime.session).toMatchObject({
      sessionId: 'session',
      terminalId: null,
      status: 'exited',
      exitCode: 0
    });
  });

  it('does not overwrite a fast terminal exit with the delayed start response', async () => {
    const store = new SessionsStore();
    store.sessions = [session()];
    store.runtime = {
      session: {
        sessionId: 'session',
        terminalId: null,
        status: 'exited'
      }
    };
    let resolveStart!: (result: TerminalStartResult) => void;
    terminalStart.mockReturnValueOnce(
      new Promise<TerminalStartResult>((resolve) => {
        resolveStart = resolve;
      })
    );
    store.attachListeners();

    const start = store.start('session', { focus: false });
    terminalStatusListeners[0]?.({
      sessionId: 'session',
      terminalId: 'terminal-new',
      status: 'running'
    });
    terminalExitListeners[0]?.({
      sessionId: 'session',
      terminalId: 'terminal-new',
      exitCode: 1,
      signal: null
    });
    resolveStart({
      terminalId: 'terminal-new',
      sessionId: 'session',
      pid: 123,
      spec: {
        file: 'codex',
        args: ['resume', 'thread-id'],
        cwd: '/repo/worktree',
        env: {},
        description: 'codex resume thread-id'
      }
    });
    await start;

    expect(store.runtime.session).toMatchObject({
      sessionId: 'session',
      terminalId: null,
      status: 'exited',
      exitCode: 1
    });
    store.detach();
  });

  it('tracks the live Terminal cwd without changing its Worktree identity', () => {
    const store = new SessionsStore();
    store.sessions = [session({ cwd: '/repo/worktree' })];
    store.attachListeners();

    terminalLocationListeners[0]?.({
      terminalId: 'terminal-1',
      sessionId: 'session',
      cwd: '/repo/worktree/packages/app'
    });

    expect(store.currentCwdFor('session')).toBe('/repo/worktree/packages/app');
    expect(store.sessions[0]?.cwd).toBe('/repo/worktree');
    store.detach();
  });

  it('restores the current Terminal cwd from the runtime snapshot', async () => {
    sessionList.mockResolvedValueOnce([session({ cwd: '/repo/worktree' })]);
    terminalListRunning.mockResolvedValueOnce([{
      sessionId: 'session',
      terminalId: 'terminal-1',
      runtimeMode: 'tui',
      status: 'running',
      startedAt: '2026-07-31T12:00:00.000Z',
      cwd: '/repo/worktree/packages/app'
    }]);
    const store = new SessionsStore();

    await store.load();

    expect(store.currentCwdFor('session')).toBe('/repo/worktree/packages/app');
    expect(store.sessions[0]?.cwd).toBe('/repo/worktree');
    sessionList.mockClear();
  });
});

describe('SessionsStore session changes', () => {
  it('does not duplicate a created session when its change event arrives before the response', async () => {
    const store = new SessionsStore();
    const created = session({
      id: 'onyx',
      name: 'Onyx',
      projectId: undefined
    });
    sessionCreate.mockImplementationOnce(async () => {
      sessionChanges.emit(created);
      return created;
    });
    store.attachListeners();

    await store.create({
      name: 'Onyx',
      cwd: '/repo/worktree',
      runMode: 'windows',
      launch: { type: 'terminal', shell: 'auto' }
    });

    expect(store.sessions.map((item) => item.id)).toEqual(['onyx']);
    store.detach();
  });

  it('applies deletion events idempotently to active and archived state', () => {
    const store = new SessionsStore();
    store.sessions = [session({ id: 'onyx' }), session({ id: 'ember' })];
    store.archived = [session({ id: 'onyx', archivedAt: '2026-01-02T00:00:00.000Z' })];
    store.selectedId = 'onyx';
    store.attachListeners();

    sessionDeletes.emit('onyx');
    sessionDeletes.emit('onyx');

    expect(store.sessions.map((item) => item.id)).toEqual(['ember']);
    expect(store.archived).toEqual([]);
    expect(store.selectedId).toBe('ember');
    store.detach();
  });

  it('does not let a reconnect refresh restore a session deleted mid-flight', async () => {
    let resolveList!: (sessions: Session[]) => void;
    sessionList.mockReturnValueOnce(new Promise<Session[]>((resolve) => {
      resolveList = resolve;
    }));
    const store = new SessionsStore();
    store.sessions = [session({ id: 'onyx' })];
    store.attachListeners();

    connectionReconnects.emit();
    await Promise.resolve();
    sessionDeletes.emit('onyx');
    resolveList([session({ id: 'onyx' })]);

    await vi.waitFor(() => expect(sessionList).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.loading).toBe(false));
    expect(store.sessions).toEqual([]);
    store.detach();
  });

  it('selects a surviving session when reconnect reveals a missed deletion', async () => {
    sessionList.mockResolvedValueOnce([session({ id: 'ember' })]);
    const store = new SessionsStore();
    store.sessions = [session({ id: 'onyx' }), session({ id: 'ember' })];
    store.selectedId = 'onyx';
    store.attachListeners();

    connectionReconnects.emit();

    await vi.waitFor(() => expect(store.loading).toBe(false));
    expect(store.sessions.map((item) => item.id)).toEqual(['ember']);
    expect(store.selectedId).toBe('ember');
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
