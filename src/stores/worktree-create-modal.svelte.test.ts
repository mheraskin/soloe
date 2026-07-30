/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { suggestedWorktreePath } from './worktree-create-modal.svelte';

describe('suggestedWorktreePath', () => {
  it('builds a sibling folder from a Linux branch name', () => {
    expect(suggestedWorktreePath('/home/me/soloe', 'feature/worktrees')).toBe(
      '/home/me/soloe-feature-worktrees'
    );
  });

  it('preserves Windows separators', () => {
    expect(suggestedWorktreePath('D:\\projects\\soloe', 'fix/ui')).toBe(
      'D:\\projects\\soloe-fix-ui'
    );
  });
});
