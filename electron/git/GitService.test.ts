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

  it('shortstat: counts untracked file lines as insertions', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'new.txt'), 'one\ntwo\nthree\n', 'utf8');

    const stat = await svc.getShortstat(tmpRoot);
    expect(stat.filesChanged).toBe(1);
    expect(stat.insertions).toBe(3);
    expect(stat.deletions).toBe(0);
  });

  it('shortstat: combines tracked and untracked changes', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'a\nb\n', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'new.txt'), 'x\ny\n', 'utf8');

    const stat = await svc.getShortstat(tmpRoot, true);
    expect(stat.filesChanged).toBe(2);
    expect(stat.insertions).toBe(3);
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

  it('listWorktrees: force refresh sees worktrees added after the first lookup', async () => {
    await initRepo(tmpRoot);
    const cached = await svc.listWorktrees(tmpRoot);
    expect(cached).toHaveLength(1);

    const worktreePath = path.join(path.dirname(tmpRoot), `${path.basename(tmpRoot)}-feature`);
    const added = spawnSync(
      'git',
      ['worktree', 'add', '-q', '-b', 'feature/worktree', worktreePath],
      { cwd: tmpRoot }
    );
    expect(added.status).toBe(0);

    try {
      const stale = await svc.listWorktrees(tmpRoot);
      expect(stale).toHaveLength(1);

      const refreshed = await svc.listWorktrees(tmpRoot, true);
      expect(refreshed.map((wt) => wt.path)).toContain(worktreePath);
      expect(refreshed).toContainEqual(
        expect.objectContaining({ path: worktreePath, branch: 'feature/worktree' })
      );
    } finally {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  });

  it('listWorktrees: reads WSL worktrees when native path resolution cannot stat the repo', async () => {
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: '/home/me/soloe\n', stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: '/home/me/soloe/.git\n', stderr: '' };
        }
        if (command === 'worktree list --porcelain') {
          return {
            code: 0,
            stdout: [
              'worktree /home/me/soloe',
              'HEAD aaa',
              'branch refs/heads/main',
              '',
              'worktree /home/me/soloe-2',
              'HEAD bbb',
              'branch refs/heads/soloe-2',
              ''
            ].join('\n'),
            stderr: ''
          };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const worktrees = await wslSvc.listWorktrees('/home/me/soloe', true, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });

      expect(worktrees).toEqual([
        expect.objectContaining({ path: '/home/me/soloe', branch: 'main', isMain: true }),
        expect.objectContaining({ path: '/home/me/soloe-2', branch: 'soloe-2' })
      ]);
    } finally {
      wslSvc.dispose();
    }
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

  it('listWorkingChanges: empty for clean repo', async () => {
    await initRepo(tmpRoot);
    const res = await svc.listWorkingChanges(tmpRoot);
    expect(res.isRepo).toBe(true);
    expect(res.changes).toEqual([]);
  });

  it('listWorkingChanges: covers modified, deleted, and untracked entries', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'kept\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tmpRoot });
    spawnSync('git', ['commit', '-m', 'second'], { cwd: tmpRoot });

    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'changed\n', 'utf8');
    await fs.unlink(path.join(tmpRoot, 'b.txt'));
    await fs.writeFile(path.join(tmpRoot, 'c.txt'), 'fresh\nlines\n', 'utf8');

    const res = await svc.listWorkingChanges(tmpRoot);
    const byPath = new Map(res.changes.map((c) => [c.path, c]));

    expect(byPath.get('a.txt')).toMatchObject({ kind: 'modified', insertions: 1, deletions: 1 });
    expect(byPath.get('b.txt')).toMatchObject({ kind: 'deleted', deletions: 1 });
    expect(byPath.get('c.txt')).toMatchObject({ kind: 'untracked', insertions: 2, deletions: 0 });
  });

  it('getFileDiff: produces hunks with correct old/new line numbers', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'a\nb\nc\nd\ne\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tmpRoot });
    spawnSync('git', ['commit', '-m', 'expand'], { cwd: tmpRoot });

    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'a\nb\nzz\nd\ne\n', 'utf8');
    const diff = await svc.getFileDiff(tmpRoot, 'a.txt');

    expect(diff.kind).toBe('modified');
    expect(diff.binary).toBe(false);
    expect(diff.hunks.length).toBeGreaterThan(0);
    const hunk = diff.hunks[0]!;
    const removed = hunk.lines.find((l) => l.kind === 'remove');
    const added = hunk.lines.find((l) => l.kind === 'add');
    expect(removed?.oldLine).toBe(3);
    expect(added?.newLine).toBe(3);
  });

  it('getFileDiff: handles untracked files via the no-index fallback', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'fresh.txt'), 'one\ntwo\n', 'utf8');

    const diff = await svc.getFileDiff(tmpRoot, 'fresh.txt');
    expect(diff.kind).toBe('untracked');
    expect(diff.empty).toBe(false);
    const adds = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add');
    expect(adds.length).toBe(2);
    expect(adds[0]?.text).toBe('one');
  });

  it('listWorkingChanges: routes through WSL git for POSIX worktree paths', async () => {
    const calls: string[] = [];
    const wslSvc = new GitService({
      runWslGit: async (_distro, cwd, args) => {
        const command = args.join(' ');
        calls.push(`${cwd}::${command}`);
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: '/home/me/repo\n', stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: '/home/me/repo/.git\n', stderr: '' };
        }
        if (command.startsWith('diff --no-color --numstat -z --diff-filter=AMDRCT HEAD')) {
          return { code: 0, stdout: '2\t1\tsrc/a.ts\0', stderr: '' };
        }
        if (command === 'status --porcelain=v1 -z') {
          return { code: 0, stdout: ' M src/a.ts\0', stderr: '' };
        }
        if (command === 'ls-files --others --exclude-standard -z') {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const result = await wslSvc.listWorkingChanges('/home/me/repo', {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });

      expect(result.isRepo).toBe(true);
      expect(result.repoPath).toBe('/home/me/repo');
      expect(result.changes).toEqual([
        expect.objectContaining({ path: 'src/a.ts', kind: 'modified', insertions: 2, deletions: 1 })
      ]);
      // Every git invocation must have been dispatched through the WSL stub.
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      wslSvc.dispose();
    }
  });

  it('getFileDiff: routes through WSL git including the untracked fallback', async () => {
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: '/home/me/repo\n', stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: '/home/me/repo/.git\n', stderr: '' };
        }
        if (command.includes('--no-index') && command.includes('/dev/null')) {
          return {
            code: 1,
            stdout: [
              'diff --git a/dev/null b/fresh.txt',
              'new file mode 100644',
              'index 0000000..e69de29',
              '--- a/dev/null',
              '+++ b/fresh.txt',
              '@@ -0,0 +1,2 @@',
              '+one',
              '+two',
              ''
            ].join('\n'),
            stderr: ''
          };
        }
        // The tracked attempt returns an empty diff so the fallback kicks in.
        if (command.startsWith('diff --no-color --no-ext-diff')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const diff = await wslSvc.getFileDiff('/home/me/repo', 'fresh.txt', {
        context: { runMode: 'wsl', wslDistro: 'Ubuntu' }
      });
      expect(diff.kind).toBe('untracked');
      expect(diff.hunks).toHaveLength(1);
      const adds = diff.hunks[0]!.lines.filter((l) => l.kind === 'add');
      expect(adds.map((l) => l.text)).toEqual(['one', 'two']);
    } finally {
      wslSvc.dispose();
    }
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
