import type { GitWorktree } from '@shared/types/git.js';
import {
  worktreeRuntimeContext,
  worktreeScope,
  type WorktreeScope
} from '@shared/worktree-identity.js';

export interface BranchReviewScopeResolution {
  scope: WorktreeScope;
  worktree: GitWorktree | null;
}

export function resolveBranchReviewScope(
  currentScope: WorktreeScope,
  branch: string,
  worktrees: readonly GitWorktree[]
): BranchReviewScopeResolution {
  const worktree = worktrees.find(
    (candidate) => !candidate.bare && !candidate.detached && candidate.branch === branch
  ) ?? null;
  if (!worktree) return { scope: currentScope, worktree: null };
  return {
    scope: worktreeScope(worktree.path, worktreeRuntimeContext(currentScope)),
    worktree
  };
}
