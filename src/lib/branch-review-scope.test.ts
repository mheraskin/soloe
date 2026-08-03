import { describe, expect, it } from 'vitest';
import { worktreeScope } from '@shared/worktree-identity.js';
import type { GitWorktree } from '@shared/types/git.js';
import { resolveBranchReviewScope } from './branch-review-scope';

const worktrees: GitWorktree[] = [
  {
    path: '/home/me/project',
    branch: 'main',
    head: '1111111111111111111111111111111111111111',
    detached: false,
    bare: false,
    isMain: true
  },
  {
    path: '/tmp/project-feature.A1b2C3',
    branch: 'feat/from-temporary-worktree',
    head: '2222222222222222222222222222222222222222',
    detached: false,
    bare: false,
    isMain: false
  }
];

describe('resolveBranchReviewScope', () => {
  const current = worktreeScope('/home/me/project', {
    runMode: 'wsl',
    wslDistro: 'Ubuntu'
  });

  it('uses the checkout path that owns the selected branch regardless of its folder', () => {
    expect(resolveBranchReviewScope(current, 'feat/from-temporary-worktree', worktrees)).toEqual({
      scope: worktreeScope('/tmp/project-feature.A1b2C3', {
        runMode: 'wsl',
        wslDistro: 'Ubuntu'
      }),
      worktree: worktrees[1]
    });
  });

  it('keeps the current scope when the branch is not checked out in a worktree', () => {
    expect(resolveBranchReviewScope(current, 'feat/not-checked-out', worktrees)).toEqual({
      scope: current,
      worktree: null
    });
  });
});
