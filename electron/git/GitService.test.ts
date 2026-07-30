import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps passive repository reads watcher-free and observes only while leased', async () => {
    await initRepo(tmpRoot);
    const closes = [vi.fn(), vi.fn(), vi.fn()];
    let watcherIndex = 0;
    const watchImpl = vi.fn(() => ({
      close: closes[watcherIndex++]!
    }));
    const observedSvc = new GitService({ watchImpl: watchImpl as never });

    try {
      await observedSvc.listWorktrees(tmpRoot, true);
      await observedSvc.getWorkingTreeSnapshot(tmpRoot, true);
      expect(watchImpl).not.toHaveBeenCalled();

      const releaseFirst = await observedSvc.acquireObservation(tmpRoot);
      const releaseSecond = await observedSvc.acquireObservation(tmpRoot);
      expect(watchImpl).toHaveBeenCalledTimes(3);

      releaseFirst();
      expect(closes.every((close) => close.mock.calls.length === 0)).toBe(true);
      releaseSecond();
      expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);

      releaseSecond();
      expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
    } finally {
      observedSvc.dispose();
    }
  });

  it('keeps passive repository caches bounded by least-recent use', async () => {
    const roots = await Promise.all(
      ['one', 'two', 'three'].map(async (name) => {
        const root = path.join(tmpRoot, name);
        await fs.mkdir(root);
        return root;
      })
    );
    const worktreeLists: string[] = [];
    const boundedSvc = new GitService({
      maxRepoCaches: 2,
      runGit: async (cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: `${cwd}\n`, stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: `${path.join(cwd, '.git')}\n`, stderr: '' };
        }
        if (command === 'worktree list --porcelain') {
          worktreeLists.push(cwd);
          return {
            code: 0,
            stdout: `worktree ${cwd}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n\n`,
            stderr: ''
          };
        }
        return { code: 1, stdout: '', stderr: `unexpected: ${command}` };
      }
    });

    try {
      for (const root of roots) await boundedSvc.listWorktrees(root);
      await boundedSvc.listWorktrees(roots[0]!);
      expect(worktreeLists).toEqual([...roots, roots[0]]);
    } finally {
      boundedSvc.dispose();
    }
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

  it('shortstat: keeps WSL Git command count constant as untracked files grow', async () => {
    const files = Array.from({ length: 40 }, (_, index) => `new-${index}.txt`);
    await Promise.all(
      files.map((file, index) =>
        fs.writeFile(path.join(tmpRoot, file), `line ${index}\nsecond\n`, 'utf8')
      )
    );
    const calls: string[] = [];
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: `${tmpRoot}\n`, stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: `${path.join(tmpRoot, '.git')}\n`, stderr: '' };
        }
        if (command === 'status --porcelain=v2 --branch --untracked-files=all -z') {
          return {
            code: 0,
            stdout: [...files.map((file) => `? ${file}`), ''].join('\0'),
            stderr: ''
          };
        }
        if (command.startsWith('diff --no-color --numstat -z --diff-filter=AMDRCT HEAD')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const stat = await wslSvc.getShortstat(tmpRoot, true, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });

      expect(stat).toMatchObject({ filesChanged: 40, insertions: 80, deletions: 0 });
      // Two repository-discovery commands, one tracked diff, and one untracked
      // listing. Per-file measurement must not spawn another wsl.exe process.
      expect(calls).toHaveLength(4);
    } finally {
      wslSvc.dispose();
    }
  });

  it('working snapshot: derives status, totals, and change rows from one generation', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'a\nb\n', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'new.txt'), 'one\ntwo', 'utf8');

    const snapshot = await svc.getWorkingTreeSnapshot(tmpRoot, true);

    expect(snapshot.status).toMatchObject({
      cwd: tmpRoot,
      repoPath: tmpRoot,
      dirty: true,
      unstaged: 1,
      untracked: 1
    });
    expect(snapshot.shortstat).toMatchObject({
      repoPath: tmpRoot,
      filesChanged: 2,
      insertions: 3,
      deletions: 0
    });
    expect(snapshot.workingChanges.changes).toEqual([
      expect.objectContaining({ path: 'a.txt', kind: 'modified', insertions: 1 }),
      expect.objectContaining({ path: 'new.txt', kind: 'untracked', insertions: 2 })
    ]);
    expect(snapshot.generation).toBeGreaterThan(0);
  });

  it('working snapshot: coalesces concurrent WSL observations with constant process count', async () => {
    const files = Array.from({ length: 30 }, (_, index) => `snapshot-${index}.txt`);
    await Promise.all(
      files.map((file) => fs.writeFile(path.join(tmpRoot, file), 'one\ntwo\n', 'utf8'))
    );
    const calls: string[] = [];
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: `${tmpRoot}\n`, stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: `${path.join(tmpRoot, '.git')}\n`, stderr: '' };
        }
        if (command === 'status --porcelain=v2 --branch --untracked-files=all -z') {
          return {
            code: 0,
            stdout: [
              '# branch.oid abcdef',
              '# branch.head main',
              ...files.map((file) => `? ${file}`),
              ''
            ].join('\0'),
            stderr: ''
          };
        }
        if (command.startsWith('diff --no-color --numstat -z --diff-filter=AMDRCT HEAD')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const context = { runMode: 'wsl' as const, wslDistro: 'Ubuntu' };
      const [first, joined] = await Promise.all([
        wslSvc.getWorkingTreeSnapshot(tmpRoot, true, context),
        wslSvc.getWorkingTreeSnapshot(tmpRoot, true, context)
      ]);

      expect(first.generation).toBe(joined.generation);
      expect(first.shortstat).toMatchObject({ filesChanged: 30, insertions: 60 });
      // Two coalesced discovery commands and two snapshot commands.
      expect(calls).toHaveLength(4);

      const cached = await wslSvc.getWorkingTreeSnapshot(tmpRoot, false, context);
      expect(cached.generation).toBe(first.generation);
      expect(calls).toHaveLength(4);
    } finally {
      wslSvc.dispose();
    }
  });

  it('working snapshot: retries a transient status spawn failure', async () => {
    let statusAttempts = 0;
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: `${tmpRoot}\n`, stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: `${path.join(tmpRoot, '.git')}\n`, stderr: '' };
        }
        if (command === 'status --porcelain=v2 --branch --untracked-files=all -z') {
          statusAttempts += 1;
          if (statusAttempts === 1) return { code: null, stdout: '', stderr: 'EAGAIN' };
          return {
            code: 0,
            stdout: ['# branch.oid abcdef', '# branch.head main', ''].join('\0'),
            stderr: ''
          };
        }
        if (command.startsWith('diff --no-color --numstat -z --diff-filter=AMDRCT HEAD')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const snapshot = await wslSvc.getWorkingTreeSnapshot(tmpRoot, true, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });
      expect(snapshot.status).toMatchObject({ isRepo: true, branch: 'main' });
      expect(statusAttempts).toBe(2);
    } finally {
      wslSvc.dispose();
    }
  });

  it('working snapshot: retries a transient tracked-diff spawn failure', async () => {
    let trackedAttempts = 0;
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: `${tmpRoot}\n`, stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: `${path.join(tmpRoot, '.git')}\n`, stderr: '' };
        }
        if (command === 'status --porcelain=v2 --branch --untracked-files=all -z') {
          return {
            code: 0,
            stdout: ['# branch.oid abcdef', '# branch.head main', ''].join('\0'),
            stderr: ''
          };
        }
        if (command.startsWith('diff --no-color --numstat -z --diff-filter=AMDRCT HEAD')) {
          trackedAttempts += 1;
          if (trackedAttempts === 1) {
            return { code: null, stdout: '', stderr: 'EAGAIN: resource temporarily unavailable' };
          }
          return { code: 0, stdout: '1\t0\ta.txt\0', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const snapshot = await wslSvc.getWorkingTreeSnapshot(tmpRoot, true, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });
      expect(snapshot.shortstat).toMatchObject({ filesChanged: 1, insertions: 1 });
      expect(snapshot.workingChanges.changes).toEqual([
        expect.objectContaining({ path: 'a.txt', insertions: 1 })
      ]);
      expect(trackedAttempts).toBe(2);
    } finally {
      wslSvc.dispose();
    }
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

  it('listRefHistory: returns one decorated graph across local branches', async () => {
    await initRepo(tmpRoot);
    spawnSync('git', ['switch', '-c', 'feature/history'], { cwd: tmpRoot });
    await fs.writeFile(path.join(tmpRoot, 'feature.txt'), 'feature\n', 'utf8');
    spawnSync('git', ['add', 'feature.txt'], { cwd: tmpRoot });
    spawnSync('git', ['commit', '-m', 'feature commit'], { cwd: tmpRoot });
    spawnSync('git', ['switch', 'main'], { cwd: tmpRoot });

    const history = await svc.listRefHistory(tmpRoot, 50, true);
    const feature = history.find((commit) => commit.subject === 'feature commit');
    const main = history.find((commit) => commit.subject === 'initial');

    expect(feature).toMatchObject({
      parents: [main?.hash],
      refs: [
        expect.objectContaining({
          name: 'feature/history',
          kind: 'branch'
        })
      ]
    });
    expect(main?.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'main',
          kind: 'branch',
          current: true
        })
      ])
    );
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

  it('createWorktree: creates a new branch and returns the discovered worktree', async () => {
    await initRepo(tmpRoot);
    const worktreePath = path.join(path.dirname(tmpRoot), `${path.basename(tmpRoot)}-created`);

    try {
      const created = await svc.createWorktree(
        tmpRoot,
        worktreePath,
        'feature/created',
        'main'
      );

      expect(created).toMatchObject({
        path: worktreePath,
        branch: 'feature/created',
        detached: false
      });
      expect((await fs.stat(worktreePath)).isDirectory()).toBe(true);
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

  it('listWorktrees: reuses WSL repository identity across minute inventory cycles', async () => {
    const repoPath = '/home/me/soloe';
    const calls: string[] = [];
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: `${repoPath}\n`, stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: `${repoPath}/.git\n`, stderr: '' };
        }
        if (command === 'worktree list --porcelain') {
          return {
            code: 0,
            stdout: `worktree ${repoPath}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n\n`,
            stderr: ''
          };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      await wslSvc.listWorktrees(repoPath, true, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });
      now.mockReturnValue(1_060_000);
      await wslSvc.listWorktrees(repoPath, true, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });

      expect(calls.filter((command) => command === 'rev-parse --show-toplevel')).toHaveLength(1);
      expect(calls.filter((command) => command === 'rev-parse --git-dir')).toHaveLength(1);
      expect(calls.filter((command) => command === 'worktree list --porcelain')).toHaveLength(2);
    } finally {
      now.mockRestore();
      wslSvc.dispose();
    }
  });

  it('listWorktrees: isolates the same Linux path across WSL distributions', async () => {
    const repoPath = '/soloe-identical-path/repo';
    const calls: string[] = [];
    const wslSvc = new GitService({
      runWslGit: async (distro, _cwd, args) => {
        calls.push(`${distro}:${args.join(' ')}`);
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: `${repoPath}\n`, stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: `${repoPath}/.git\n`, stderr: '' };
        }
        if (command === 'worktree list --porcelain') {
          return {
            code: 0,
            stdout: [
              `worktree ${repoPath}`,
              `HEAD ${distro === 'Ubuntu' ? 'a' : 'b'}`.padEnd(45, distro === 'Ubuntu' ? 'a' : 'b'),
              `branch refs/heads/${distro.toLowerCase()}`,
              ''
            ].join('\n'),
            stderr: ''
          };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const ubuntu = await wslSvc.listWorktrees(repoPath, false, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });
      const debian = await wslSvc.listWorktrees(repoPath, false, {
        runMode: 'wsl',
        wslDistro: 'Debian'
      });

      expect(ubuntu[0]?.branch).toBe('ubuntu');
      expect(debian[0]?.branch).toBe('debian');
      expect(calls.filter((call) => call.endsWith('worktree list --porcelain'))).toEqual([
        'Ubuntu:worktree list --porcelain',
        'Debian:worktree list --porcelain'
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

  it('getReviewDiffs: materializes multiple tracked files with one repository patch', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'before\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: tmpRoot });
    spawnSync('git', ['commit', '-m', 'add b'], { cwd: tmpRoot });
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'after a\n', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'after b\n', 'utf8');

    const diffs = await svc.getReviewDiffs(tmpRoot, [
      { path: 'a.txt' },
      { path: 'b.txt' }
    ]);

    expect(diffs.map((diff) => diff.path)).toEqual(['a.txt', 'b.txt']);
    expect(diffs.every((diff) => !diff.empty && diff.hunks.length > 0)).toBe(true);
  });

  it('getFileLines: reads the requested historical commit rather than current HEAD', async () => {
    await initRepo(tmpRoot);
    const base = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: tmpRoot,
      encoding: 'utf8'
    }).stdout.trim();
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'head one\nhead two\n', 'utf8');
    spawnSync('git', ['add', 'a.txt'], { cwd: tmpRoot });
    spawnSync('git', ['commit', '-m', 'head version'], { cwd: tmpRoot });

    await expect(
      svc.getFileLines(tmpRoot, 'a.txt', 1, 5, {
        revision: { kind: 'commit', sha: base }
      })
    ).resolves.toEqual({ lines: ['a'], totalLines: 1 });
    await expect(svc.getFileLines(tmpRoot, 'a.txt', 1, 5)).resolves.toEqual({
      lines: ['head one', 'head two'],
      totalLines: 2
    });
  });

  it('getFileLines: rejects ambiguous historical revision names', async () => {
    await initRepo(tmpRoot);
    await expect(
      svc.getFileLines(tmpRoot, 'a.txt', 1, 1, {
        revision: { kind: 'commit', sha: 'HEAD~1' }
      })
    ).rejects.toThrow('canonical commit SHA');
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
        if (command === 'status --porcelain=v2 --branch --untracked-files=all -z') {
          return {
            code: 0,
            stdout: [
              '# branch.oid abcdef',
              '# branch.head main',
              `1 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'a'.repeat(40)} src/a.ts`,
              ''
            ].join('\0'),
            stderr: ''
          };
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

  it('listWorkingChanges: avoids per-file WSL Git processes for untracked files', async () => {
    const files = Array.from({ length: 20 }, (_, index) => `fresh-${index}.txt`);
    await Promise.all(
      files.map((file) => fs.writeFile(path.join(tmpRoot, file), 'one\ntwo\n', 'utf8'))
    );
    const calls: string[] = [];
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: `${tmpRoot}\n`, stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: `${path.join(tmpRoot, '.git')}\n`, stderr: '' };
        }
        if (command.startsWith('diff --no-color --numstat -z --diff-filter=AMDRCT HEAD')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'status --porcelain=v2 --branch --untracked-files=all -z') {
          return {
            code: 0,
            stdout: [...files.map((file) => `? ${file}`), ''].join('\0'),
            stderr: ''
          };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const result = await wslSvc.listWorkingChanges(tmpRoot, {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      });

      expect(result.changes).toHaveLength(files.length);
      expect(result.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: files[0], insertions: 2, binary: false })
        ])
      );
      expect(calls).toHaveLength(4);
    } finally {
      wslSvc.dispose();
    }
  });

  it('getFileDiff: routes known untracked files directly through WSL no-index diff', async () => {
    const calls: string[] = [];
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        calls.push(command);
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
        if (command.startsWith('diff --no-color --no-ext-diff')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const diff = await wslSvc.getFileDiff('/home/me/repo', 'fresh.txt', {
        untracked: true,
        context: { runMode: 'wsl', wslDistro: 'Ubuntu' }
      });
      expect(diff.kind).toBe('untracked');
      expect(diff.hunks).toHaveLength(1);
      const adds = diff.hunks[0]!.lines.filter((l) => l.kind === 'add');
      expect(adds.map((l) => l.text)).toEqual(['one', 'two']);
      expect(calls).toHaveLength(3);
      expect(calls.filter((command) => command.includes('--no-index'))).toHaveLength(1);
    } finally {
      wslSvc.dispose();
    }
  });

  it('getReviewDiffs: keeps WSL command count constant as file count grows', async () => {
    const calls: string[] = [];
    const wslSvc = new GitService({
      runWslGit: async (_distro, _cwd, args) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'rev-parse --show-toplevel') {
          return { code: 0, stdout: '/home/me/repo\n', stderr: '' };
        }
        if (command === 'rev-parse --git-dir') {
          return { code: 0, stdout: '/home/me/repo/.git\n', stderr: '' };
        }
        if (command.startsWith('-c core.quotePath=false diff ')) {
          return {
            code: 0,
            stdout: [
              'diff --git a/src/file-0.ts b/src/file-0.ts',
              '--- a/src/file-0.ts',
              '+++ b/src/file-0.ts',
              '@@ -1 +1 @@',
              '-old',
              '+new',
              ''
            ].join('\n'),
            stderr: ''
          };
        }
        return { code: 1, stdout: '', stderr: `unexpected git command: ${command}` };
      }
    });

    try {
      const files = Array.from({ length: 50 }, (_, index) => ({
        path: `src/file-${index}.ts`
      }));
      const diffs = await wslSvc.getReviewDiffs('/home/me/repo', files, {
        context: { runMode: 'wsl', wslDistro: 'Ubuntu' }
      });

      expect(diffs).toHaveLength(1);
      expect(diffs[0]?.path).toBe('src/file-0.ts');
      // Two discovery commands plus one repository-level diff, independent
      // of whether the review contains 5, 50, or 200 tracked files.
      expect(calls).toHaveLength(3);

      await wslSvc.getReviewDiffs('/home/me/repo', files, {
        context: { runMode: 'wsl', wslDistro: 'Ubuntu' }
      });
      // A refresh only adds the useful diff command; repository discovery is
      // reused across the polling window.
      expect(calls).toHaveLength(4);
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
