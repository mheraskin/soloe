import { describe, expect, it } from 'vitest';
import type { GitWorktree } from '@shared/types/git.js';
import { buildWorktreeGroups } from './worktree-groups';

const gitWorktree = (path: string, isMain = false): GitWorktree => ({
  path,
  branch: isMain ? 'main' : null,
  head: 'a'.repeat(40),
  detached: false,
  bare: false,
  isMain
});

describe('buildWorktreeGroups', () => {
  it('collapses Windows spelling variants without changing the display path', () => {
    const groups = buildWorktreeGroups({
      projectPath: 'C:\\Code\\Soloe',
      runMode: 'windows',
      worktrees: [gitWorktree('C:\\Code\\Soloe', true)],
      items: [{ id: 'session', cwd: 'c:/code/soloe/' }]
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      cwd: 'C:\\Code\\Soloe',
      label: 'main',
      isMain: true,
      items: [{ id: 'session' }]
    });
  });

  it('applies user order before retaining newly discovered natural order', () => {
    const groups = buildWorktreeGroups({
      projectPath: '/repo',
      runMode: 'wsl',
      worktrees: [
        gitWorktree('/repo', true),
        gitWorktree('/repo/new'),
        gitWorktree('/repo/placed')
      ],
      items: [],
      orderedPaths: ['/repo/placed', '/repo']
    });

    expect(groups.map((group) => group.cwd)).toEqual([
      '/repo/placed', '/repo', '/repo/new'
    ]);
  });
});
