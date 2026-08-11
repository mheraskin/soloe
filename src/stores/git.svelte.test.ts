/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitWorktree } from '@shared/types/git.js';
import { worktreeScope } from '@shared/worktree-identity.js';

const { worktrees, changeListeners, reconnectListeners, setObservationDemand } = vi.hoisted(() => ({
  worktrees: vi.fn(async (_request: {
    repoPath: string;
    force?: boolean;
    runMode?: 'windows' | 'wsl';
    wslDistro?: string;
  }) => [] as GitWorktree[]),
  setObservationDemand: vi.fn(async (_request: {
    cwd: string;
    active: boolean;
    runMode?: 'windows' | 'wsl';
    wslDistro?: string;
  }) => true as const),
  changeListeners: new Set<(event: {
    repoPath: string;
    runMode: 'windows' | 'wsl';
    wslDistro?: string;
  }) => void>(),
  reconnectListeners: new Set<() => void>()
}));

const status = vi.fn(async ({ cwd }: { cwd: string }) => ({
  repoPath: cwd,
  isRepo: true,
  dirty: false
}));
const shortstat = vi.fn(async ({ repoPath }: { repoPath: string }) => ({
  repoPath,
  isRepo: true,
  filesChanged: 0,
  insertions: 0,
  deletions: 0
}));
const workingTreeSnapshot = vi.fn(async ({
  cwd,
  wslDistro
}: { cwd: string; wslDistro?: string }) => ({
  generation: 1,
  status: {
    repoPath: cwd,
    cwd,
    isRepo: true,
    dirty: false,
    branch: wslDistro?.toLowerCase() ?? 'native'
  },
  shortstat: {
    repoPath: cwd,
    isRepo: true,
    filesChanged: 0,
    insertions: 0,
    deletions: 0
  },
  workingChanges: { repoPath: cwd, isRepo: true, changes: [] }
}));
vi.mock('../lib/ipc', () => ({
  ipc: {
    connection: {
      onReconnect: vi.fn((listener: () => void) => {
        reconnectListeners.add(listener);
        return () => reconnectListeners.delete(listener);
      })
    },
    git: {
      status: (...args: unknown[]) => status(...(args as [{ cwd: string }])),
      shortstat: (...args: unknown[]) => shortstat(...(args as [{ repoPath: string }])),
      workingTreeSnapshot: (...args: unknown[]) =>
        workingTreeSnapshot(...(args as [{ cwd: string; wslDistro?: string }])),
      setObservationDemand,
      worktrees,
      onChange: vi.fn((listener: (event: {
        repoPath: string;
        runMode: 'windows' | 'wsl';
        wslDistro?: string;
      }) => void) => {
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
      })
    }
  }
}));

import { git } from './git.svelte';

// A bounded observation can release capacity and schedule another due job on
// the next timer turn. Let the complete scheduler handoff settle.
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

let seq = 0;
const freshCwd = () => `/repo-${(seq += 1)}-${Date.now()}`;

describe('GitStore polling', () => {
  beforeEach(() => {
    status.mockClear();
    shortstat.mockClear();
    workingTreeSnapshot.mockClear();
    worktrees.mockClear();
    setObservationDemand.mockClear();
    changeListeners.clear();
    reconnectListeners.clear();
  });

  afterEach(() => {
    git.detach();
  });

  it('polls a newly tracked worktree once so its badge appears', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([{ cwd, cadence: 'background' }]);
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(shortstat).not.toHaveBeenCalled();
  });

  it('does not re-observe when a Worktree only changes cadence', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([{ cwd, cadence: 'background' }]);
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(1);
    expect(setObservationDemand).toHaveBeenCalledTimes(1);

    // Selecting a Session in this Worktree promotes it to foreground cadence. The
    // status it already holds is current, so no extra `git status` may run.
    git.setWorktreePolling([{ cwd, cadence: 'foreground' }]);
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(1);
    expect(setObservationDemand).toHaveBeenCalledTimes(1);

    // Selecting away returns it to background cadence — still no extra spawn.
    git.setWorktreePolling([{ cwd, cadence: 'background' }]);
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(1);
    expect(setObservationDemand).toHaveBeenCalledTimes(1);
  });

  it('keeps Refresh Intents and observations distinct across WSL distributions', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([
      { cwd, cadence: 'background', runMode: 'wsl', wslDistro: 'Ubuntu' },
      { cwd, cadence: 'background', runMode: 'wsl', wslDistro: 'Debian' }
    ]);
    await settle();

    expect(workingTreeSnapshot).toHaveBeenCalledTimes(2);
    expect(workingTreeSnapshot.mock.calls.map(([request]) => request.wslDistro).sort()).toEqual([
      'Debian',
      'Ubuntu'
    ]);
    expect(git.statusFor(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' })?.branch).toBe(
      'ubuntu'
    );
    expect(git.statusFor(cwd, { runMode: 'wsl', wslDistro: 'Debian' })?.branch).toBe(
      'debian'
    );
    expect(git.statusFor(worktreeScope(cwd, {
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    }))?.branch).toBe('ubuntu');
  });

  it('routes a filesystem event only to its runtime-qualified Refresh Intent', async () => {
    const cwd = freshCwd();
    git.attachListeners();
    git.setWorktreePolling([
      { cwd, cadence: 'background', runMode: 'wsl', wslDistro: 'Ubuntu' },
      { cwd, cadence: 'background', runMode: 'wsl', wslDistro: 'Debian' }
    ]);
    await settle();
    workingTreeSnapshot.mockClear();

    for (const listener of changeListeners) {
      listener({ repoPath: cwd, runMode: 'wsl', wslDistro: 'Ubuntu' });
    }
    await settle();

    expect(workingTreeSnapshot).toHaveBeenCalledTimes(1);
    expect(workingTreeSnapshot.mock.calls[0]?.[0].wslDistro).toBe('Ubuntu');
  });

  it('reacquires observation demand and refreshes active worktrees after reconnect', async () => {
    const cwd = freshCwd();
    git.attachListeners();
    git.setWorktreePolling([
      { cwd, cadence: 'foreground', runMode: 'wsl', wslDistro: 'Ubuntu' }
    ]);
    await settle();
    setObservationDemand.mockClear();
    workingTreeSnapshot.mockClear();

    for (const listener of reconnectListeners) listener();
    await settle();

    expect(setObservationDemand).toHaveBeenCalledOnce();
    expect(setObservationDemand).toHaveBeenCalledWith({
      cwd,
      active: true,
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    expect(workingTreeSnapshot).toHaveBeenCalledOnce();
  });

  it('does not stampede idle worktrees when polling resumes', async () => {
    const cwds = [freshCwd(), freshCwd(), freshCwd()];
    git.setWorktreePolling(cwds.map((cwd) => ({ cwd, cadence: 'background' })));
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(3);

    git.setPaused(true);
    git.setPaused(false);
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(3);
  });

  it('refreshes the worktree the user is looking at when polling resumes', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([{ cwd, cadence: 'foreground' }]);
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(1);

    git.setPaused(true);
    git.setPaused(false);
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps Worktree Inventory separate from recurring snapshot demand', async () => {
    const repoPath = freshCwd();
    const linkedWorktrees = Array.from({ length: 50 }, (_, index): GitWorktree => ({
      path: `${repoPath}/linked-${index}`,
      branch: `feature-${index}`,
      head: `${index}`.padStart(40, '0'),
      detached: false,
      bare: false,
      isMain: false
    }));
    worktrees.mockResolvedValueOnce(linkedWorktrees).mockResolvedValueOnce([]);

    await git.refreshProjectWorktrees([
      { repoPath, cadence: 'foreground', runMode: 'wsl', wslDistro: 'Ubuntu' },
      {
        repoPath: `${repoPath}/missing`,
        cadence: 'background',
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      }
    ]);
    await settle();

    expect(worktrees).toHaveBeenCalledTimes(2);
    expect(workingTreeSnapshot).not.toHaveBeenCalled();
    expect(setObservationDemand).not.toHaveBeenCalled();
  });

  it('refreshes only foreground Inventory on resume instead of every Project', async () => {
    vi.useFakeTimers();
    try {
      const active = freshCwd();
      const background = Array.from({ length: 20 }, () => freshCwd());
      await git.refreshProjectWorktrees([
        { repoPath: active, cadence: 'foreground', runMode: 'wsl', wslDistro: 'Ubuntu' },
        ...background.map((repoPath) => ({
          repoPath,
          cadence: 'background' as const,
          runMode: 'wsl' as const,
          wslDistro: 'Ubuntu'
        }))
      ]);
      // Both the Inventory coordinator and the shared Git budget serialize a
      // WSL distribution. Drain each zero-delay handoff without advancing to
      // the next recurring cadence.
      for (let turn = 0; turn < 50 && worktrees.mock.calls.length < 21; turn += 1) {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(worktrees).toHaveBeenCalledTimes(21);
      worktrees.mockClear();

      git.setPaused(true);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(worktrees).not.toHaveBeenCalled();
      git.setPaused(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(worktrees).toHaveBeenCalledOnce();
      expect(worktrees.mock.calls[0]?.[0]).toMatchObject({ repoPath: active, force: true });
    } finally {
      git.detach();
      vi.useRealTimers();
    }
  });

  it('does not replace renderer Inventory state when a forced result is unchanged', async () => {
    const repoPath = freshCwd();
    const inventory: GitWorktree[] = [{
      path: repoPath,
      branch: 'main',
      head: 'a'.repeat(40),
      detached: false,
      bare: false,
      isMain: true
    }];
    worktrees.mockResolvedValue(inventory);
    const listener = vi.fn();
    const off = git.onWorktrees(listener);
    await git.loadWorktrees(repoPath, false);
    const stateAfterInitial = git.worktrees;

    await git.loadWorktrees(repoPath, true);

    expect(git.worktrees).toBe(stateAfterInitial);
    // Session integrity still receives every authoritative success.
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it('owns one Git Observation Lease per runtime-qualified Session intent', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([
      { cwd, cadence: 'background', runMode: 'wsl', wslDistro: 'Ubuntu' },
      { cwd, cadence: 'background', runMode: 'wsl', wslDistro: 'Debian' }
    ]);
    await settle();

    expect(setObservationDemand.mock.calls.map(([request]) => request)).toEqual([
      { cwd, active: true, runMode: 'wsl', wslDistro: 'Ubuntu' },
      { cwd, active: true, runMode: 'wsl', wslDistro: 'Debian' }
    ]);

    setObservationDemand.mockClear();
    git.setWorktreePolling([
      { cwd, cadence: 'foreground', runMode: 'wsl', wslDistro: 'Ubuntu' }
    ]);
    await settle();

    expect(setObservationDemand).toHaveBeenCalledOnce();
    expect(setObservationDemand).toHaveBeenCalledWith({
      cwd,
      active: false,
      runMode: 'wsl',
      wslDistro: 'Debian'
    });
  });

  it('releases stale badge evidence with the final Session intent and reacquires eagerly', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([{ cwd, cadence: 'background' }]);
    await settle();
    expect(git.shortstatFor(cwd)).not.toBeNull();

    git.setWorktreePolling([]);
    expect(git.shortstatFor(cwd)).toBeNull();
    expect(git.statusFor(cwd)).toBeNull();

    git.setWorktreePolling([{ cwd, cadence: 'background' }]);
    await settle();
    expect(workingTreeSnapshot).toHaveBeenCalledTimes(2);
    expect(git.shortstatFor(cwd)).not.toBeNull();
  });

  it('publishes successful Worktree inventories and isolates listeners', async () => {
    const repoPath = freshCwd();
    const inventory: GitWorktree[] = [{
      path: repoPath,
      branch: 'main',
      head: 'a'.repeat(40),
      detached: false,
      bare: false,
      isMain: true
    }];
    worktrees.mockResolvedValueOnce(inventory);
    const throwing = git.onWorktrees(() => {
      throw new Error('consumer failed');
    });
    const listener = vi.fn();
    const off = git.onWorktrees(listener);

    await expect(git.loadWorktrees(repoPath, false, {
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    })).resolves.toEqual(inventory);
    expect(listener).toHaveBeenCalledWith({
      repoPath,
      worktrees: inventory,
      context: { runMode: 'wsl', wslDistro: 'Ubuntu' }
    });

    throwing();
    off();
  });
});
