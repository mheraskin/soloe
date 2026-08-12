import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GitService } from '../git/GitService.js';

const directories: string[] = [];

describe('Workspace remote Git primitives', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('clones directly on the target and captures explicit remote evidence', async () => {
    const fixture = await remoteFixture();
    const target = path.join(fixture.directory, 'target');
    const service = new GitService({ gitBinary: 'git' });

    await service.cloneRepository(
      fixture.remote,
      target,
      { branchRef: 'refs/heads/main' }
    );
    const evidence = await service.inspectRemoteEvidence(target, {
      remote: 'origin',
      branchRef: 'refs/heads/main'
    });

    expect(evidence).toMatchObject({
      remote: 'origin',
      remoteUrl: fixture.remote,
      branchRef: 'refs/heads/main',
      localOid: fixture.initialOid,
      remoteOid: fixture.initialOid
    });
    service.dispose();
  });

  it('pushes with expected OIDs and fetches then fast-forwards without merge/reset', async () => {
    const fixture = await remoteFixture();
    const left = path.join(fixture.directory, 'left');
    const right = path.join(fixture.directory, 'right');
    const service = new GitService({ gitBinary: 'git' });
    await service.cloneRepository(fixture.remote, left, { branchRef: 'refs/heads/main' });
    await service.cloneRepository(fixture.remote, right, { branchRef: 'refs/heads/main' });
    git(left, ['config', 'user.email', 'tests@soloe.local']);
    git(left, ['config', 'user.name', 'Soloe Tests']);
    await writeFile(path.join(left, 'next.txt'), 'next\n', 'utf8');
    git(left, ['add', 'next.txt']);
    git(left, ['commit', '-m', 'next']);
    const nextOid = git(left, ['rev-parse', 'HEAD']);

    await service.pushBranch(left, {
      remote: 'origin',
      branchRef: 'refs/heads/main',
      expectedLocalOid: nextOid,
      expectedRemoteOid: fixture.initialOid
    });
    const fetched = await service.fetchRemoteEvidence(right, {
      remote: 'origin',
      branchRef: 'refs/heads/main'
    });
    expect(fetched.remoteOid).toBe(nextOid);
    expect(await service.compareRevisions(right, fixture.initialOid, nextOid)).toBe('right-ahead');

    await service.fastForwardBranch(right, {
      branchRef: 'refs/heads/main',
      expectedHeadOid: fixture.initialOid,
      targetOid: nextOid
    });
    expect(git(right, ['rev-parse', 'HEAD'])).toBe(nextOid);
    await expect(service.pushBranch(left, {
      remote: 'origin',
      branchRef: 'refs/heads/main',
      expectedLocalOid: nextOid,
      expectedRemoteOid: fixture.initialOid
    })).rejects.toThrow('remote Branch changed');
    service.dispose();
  });

  it('adds a validated new remote and publishes an exact Branch without force', async () => {
    const fixture = await remoteFixture();
    const emptyRemote = path.join(fixture.directory, 'published.git');
    git(fixture.directory, ['init', '--bare', emptyRemote]);
    const service = new GitService({ gitBinary: 'git' });

    const evidence = await service.publishNewRemoteBranch(fixture.seed, {
      remote: 'published',
      remoteUrl: emptyRemote,
      branchRef: 'refs/heads/main',
      expectedLocalOid: fixture.initialOid
    });

    expect(evidence).toMatchObject({
      remote: 'published',
      remoteUrl: emptyRemote,
      localOid: fixture.initialOid,
      remoteOid: fixture.initialOid
    });
    expect(git(fixture.seed, ['remote', 'get-url', 'published'])).toBe(emptyRemote);
    service.dispose();
  });
});

async function remoteFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-remote-git-'));
  directories.push(directory);
  const seed = path.join(directory, 'seed');
  const remote = path.join(directory, 'remote.git');
  git(directory, ['init', '-b', 'main', seed]);
  git(seed, ['config', 'user.email', 'tests@soloe.local']);
  git(seed, ['config', 'user.name', 'Soloe Tests']);
  await writeFile(path.join(seed, 'README.md'), '# fixture\n', 'utf8');
  git(seed, ['add', 'README.md']);
  git(seed, ['commit', '-m', 'initial']);
  const initialOid = git(seed, ['rev-parse', 'HEAD']);
  git(directory, ['clone', '--bare', seed, remote]);
  return { directory, seed, remote, initialOid };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
