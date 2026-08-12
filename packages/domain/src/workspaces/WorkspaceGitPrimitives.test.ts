import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitService } from '../git/GitService.js';

describe('Workspace Git primitives', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('adds existing-branch and detached Worktrees and never force-removes dirty work', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-workspace-git-'));
    directories.push(directory);
    const repository = path.join(directory, 'repository');
    git(directory, ['init', repository]);
    git(repository, ['config', 'user.email', 'tests@soloe.local']);
    git(repository, ['config', 'user.name', 'Soloe Tests']);
    await writeFile(path.join(repository, 'README.md'), '# fixture\n', 'utf8');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'initial']);
    git(repository, ['branch', 'feature']);
    const head = git(repository, ['rev-parse', 'HEAD']);
    const featurePath = path.join(directory, 'feature');
    const detachedPath = path.join(directory, 'detached');
    const service = new GitService({ gitBinary: 'git' });

    const feature = await service.addWorkspaceWorktree(
      repository,
      featurePath,
      { kind: 'existing-branch', ref: 'refs/heads/feature' }
    );
    const detached = await service.addWorkspaceWorktree(
      repository,
      detachedPath,
      { kind: 'detached', oid: head }
    );

    expect(feature).toMatchObject({ branch: 'feature', detached: false });
    expect(detached).toMatchObject({ head, detached: true });
    await writeFile(path.join(featurePath, 'untracked.txt'), 'do not lose\n', 'utf8');
    await expect(service.removeWorkspaceWorktree(repository, featurePath)).rejects.toThrow();
    expect(git(repository, ['worktree', 'list', '--porcelain'])).toContain(featurePath);
    service.dispose();
  });

  it('creates an isolated generated Branch from an exact base revision', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-isolated-git-'));
    directories.push(directory);
    const repository = path.join(directory, 'repository');
    git(directory, ['init', '-b', 'main', repository]);
    git(repository, ['config', 'user.email', 'tests@soloe.local']);
    git(repository, ['config', 'user.name', 'Soloe Tests']);
    await writeFile(path.join(repository, 'README.md'), '# fixture\n', 'utf8');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'initial']);
    const head = git(repository, ['rev-parse', 'HEAD']);
    const target = path.join(directory, 'isolated');
    const service = new GitService({ gitBinary: 'git' });

    const created = await service.addWorkspaceWorktree(repository, target, {
      kind: 'new-branch',
      ref: 'refs/heads/soloe/session/abc-experiment',
      baseOid: head
    });

    expect(created).toMatchObject({
      branch: 'soloe/session/abc-experiment',
      head,
      detached: false
    });
    service.dispose();
  });

  it('scans staged, unstaged, untracked, ignored, and unpublished work before cleanup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-loss-scan-'));
    directories.push(directory);
    const repository = path.join(directory, 'repository');
    const remote = path.join(directory, 'remote.git');
    git(directory, ['init', '-b', 'main', repository]);
    git(repository, ['config', 'user.email', 'tests@soloe.local']);
    git(repository, ['config', 'user.name', 'Soloe Tests']);
    await writeFile(path.join(repository, '.gitignore'), '.private\n', 'utf8');
    await writeFile(path.join(repository, 'README.md'), '# fixture\n', 'utf8');
    git(repository, ['add', '.gitignore', 'README.md']);
    git(repository, ['commit', '-m', 'initial']);
    git(directory, ['clone', '--bare', repository, remote]);
    git(repository, ['remote', 'add', 'origin', remote]);
    git(repository, ['push', '-u', 'origin', 'main']);
    const baseOid = git(repository, ['rev-parse', 'HEAD']);
    const isolatedPath = path.join(directory, 'isolated');
    const service = new GitService({ gitBinary: 'git' });
    await service.addWorkspaceWorktree(repository, isolatedPath, {
      kind: 'new-branch',
      ref: 'refs/heads/soloe/session/loss-scan',
      baseOid
    });

    expect(await service.scanCheckoutLoss(isolatedPath)).toMatchObject({
      certain: true,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      ignored: 0,
      unpublishedCommits: 0,
      headOid: baseOid,
      branchRef: 'refs/heads/soloe/session/loss-scan'
    });

    await writeFile(path.join(isolatedPath, 'published-later.txt'), 'commit\n', 'utf8');
    git(isolatedPath, ['add', 'published-later.txt']);
    git(isolatedPath, ['commit', '-m', 'isolated commit']);
    await writeFile(path.join(isolatedPath, 'staged.txt'), 'staged\n', 'utf8');
    git(isolatedPath, ['add', 'staged.txt']);
    await writeFile(path.join(isolatedPath, 'README.md'), '# changed\n', 'utf8');
    await writeFile(path.join(isolatedPath, 'untracked.txt'), 'untracked\n', 'utf8');
    await writeFile(path.join(isolatedPath, '.private'), 'ignored\n', 'utf8');

    expect(await service.scanCheckoutLoss(isolatedPath)).toMatchObject({
      certain: true,
      staged: 1,
      unstaged: 1,
      untracked: 1,
      ignored: 1,
      unpublishedCommits: 1
    });
    service.dispose();
  });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
