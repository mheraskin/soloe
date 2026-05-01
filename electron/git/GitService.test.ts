import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitService } from './GitService.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit)('GitService', () => {
  let tmpRoot: string;
  let svc: GitService;

  beforeEach(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-git-')));
    svc = new GitService();
  });

  afterEach(async () => {
    svc.dispose();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('status: returns isRepo=false for a non-repo directory', async () => {
    const status = await svc.getStatus(tmpRoot);
    expect(status.isRepo).toBe(false);
    expect(status.repoPath).toBeNull();
    expect(status.branch).toBeNull();
    expect(status.dirty).toBe(false);
  });

  it('status: returns isRepo=false for empty cwd', async () => {
    const status = await svc.getStatus('');
    expect(status.isRepo).toBe(false);
  });

  it('status: reports branch and clean state for a committed repo', async () => {
    await initRepo(tmpRoot);

    const status = await svc.getStatus(tmpRoot);
    expect(status.isRepo).toBe(true);
    expect(status.repoPath).toBe(tmpRoot);
    expect(status.branch).toBe('main');
    expect(status.dirty).toBe(false);
    expect(status.detached).toBe(false);
  });

  it('dirty: reports untracked and unstaged files', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'changed\n', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'new.txt'), 'new\n', 'utf8');

    const dirty = await svc.getDirty(tmpRoot);
    expect(dirty.isRepo).toBe(true);
    expect(dirty.dirty).toBe(true);
    expect(dirty.unstaged).toBeGreaterThan(0);
    expect(dirty.untracked).toBeGreaterThan(0);
  });

  it('shortstat: reports changed tracked files', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'a\nb\n', 'utf8');

    const stat = await svc.getShortstat(tmpRoot);
    expect(stat.isRepo).toBe(true);
    expect(stat.filesChanged).toBe(1);
    expect(stat.insertions).toBe(1);
  });

  it('branch and aheadBehind: read current branch counts', async () => {
    await initRepo(tmpRoot);

    await expect(svc.getBranch(tmpRoot)).resolves.toBe('main');
    await expect(svc.getAheadBehind(tmpRoot)).resolves.toMatchObject({
      isRepo: true,
      ahead: 0,
      behind: 0
    });
  });

  it('listLocalBranches and listRecentCommits: returns branch and commit metadata', async () => {
    await initRepo(tmpRoot);

    const branches = await svc.listLocalBranches(tmpRoot);
    expect(branches).toEqual([
      expect.objectContaining({ name: 'main', current: true, lastCommit: 'initial' })
    ]);

    const commits = await svc.listRecentCommits(tmpRoot, 5);
    expect(commits).toEqual([
      expect.objectContaining({ shortHash: expect.any(String), subject: 'initial' })
    ]);
  });

  it('listWorktrees: returns the main worktree', async () => {
    await initRepo(tmpRoot);

    const worktrees = await svc.listWorktrees(tmpRoot);
    expect(worktrees).toEqual([
      expect.objectContaining({ path: tmpRoot, branch: 'main', detached: false })
    ]);
  });

  it('checkout: switches branches when the repo is clean', async () => {
    await initRepo(tmpRoot);
    spawnSync('git', ['checkout', '-b', 'feature/demo'], { cwd: tmpRoot });
    await fs.writeFile(path.join(tmpRoot, 'feature.txt'), 'feature\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tmpRoot });
    spawnSync('git', ['commit', '-m', 'feature'], { cwd: tmpRoot });

    const status = await svc.checkout(tmpRoot, 'main');
    expect(status.branch).toBe('main');
    await expect(svc.getBranch(tmpRoot)).resolves.toBe('main');
  });

  it('checkout: refuses to switch when the repo is dirty', async () => {
    await initRepo(tmpRoot);
    spawnSync('git', ['checkout', '-b', 'feature/demo'], { cwd: tmpRoot });
    spawnSync('git', ['checkout', 'main'], { cwd: tmpRoot });
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'changed\n', 'utf8');

    await expect(svc.checkout(tmpRoot, 'feature/demo')).rejects.toThrow(
      'Repository has uncommitted changes'
    );
  });
});

async function initRepo(repoPath: string): Promise<void> {
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, 'a.txt'), 'a\n', 'utf8');
  spawnSync('git', ['add', '.'], { cwd: repoPath });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoPath });
}
