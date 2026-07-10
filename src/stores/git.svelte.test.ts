/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../lib/ipc', () => ({
  ipc: {
    git: {
      status: (...args: unknown[]) => status(...(args as [{ cwd: string }])),
      shortstat: (...args: unknown[]) => shortstat(...(args as [{ repoPath: string }])),
      worktrees: vi.fn(async () => []),
      onChange: vi.fn(() => () => undefined)
    }
  }
}));

import { git } from './git.svelte';

// `tick()` awaits loadStatus before resolving; give the microtask queue a turn.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let seq = 0;
const freshCwd = () => `/repo-${(seq += 1)}-${Date.now()}`;

describe('GitStore polling', () => {
  beforeEach(() => {
    status.mockClear();
    shortstat.mockClear();
  });

  afterEach(() => {
    git.detach();
  });

  it('polls a newly tracked worktree once so its badge appears', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([{ cwd, fast: false }]);
    await settle();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('does not re-poll when a worktree only changes polling tier', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([{ cwd, fast: false }]);
    await settle();
    expect(status).toHaveBeenCalledTimes(1);

    // Selecting a session in this worktree promotes it to the fast tier. The
    // status it already holds is current, so no extra `git status` may run.
    git.setWorktreePolling([{ cwd, fast: true }]);
    await settle();
    expect(status).toHaveBeenCalledTimes(1);

    // Selecting away demotes it again — still no extra spawn.
    git.setWorktreePolling([{ cwd, fast: false }]);
    await settle();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('does not stampede idle worktrees when polling resumes', async () => {
    const cwds = [freshCwd(), freshCwd(), freshCwd()];
    git.setWorktreePolling(cwds.map((cwd) => ({ cwd, fast: false })));
    await settle();
    expect(status).toHaveBeenCalledTimes(3);

    git.setPaused(true);
    git.setPaused(false);
    await settle();
    expect(status).toHaveBeenCalledTimes(3);
  });

  it('refreshes the worktree the user is looking at when polling resumes', async () => {
    const cwd = freshCwd();
    git.setWorktreePolling([{ cwd, fast: true }]);
    await settle();
    expect(status).toHaveBeenCalledTimes(1);

    git.setPaused(true);
    git.setPaused(false);
    await settle();
    expect(status).toHaveBeenCalledTimes(2);
  });
});
