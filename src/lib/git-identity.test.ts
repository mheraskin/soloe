import { describe, expect, it } from 'vitest';
import { gitIdentityParts } from './git-identity';

describe('gitIdentityParts', () => {
  it('orders the branch before the Worktree and assigns distinct icons', () => {
    expect(gitIdentityParts('feature/live-terminal-cwd', 'soloe-feature')).toEqual([
      {
        kind: 'branch',
        icon: 'branch',
        label: 'feature/live-terminal-cwd'
      },
      {
        kind: 'worktree',
        icon: 'worktree',
        label: 'soloe-feature'
      }
    ]);
  });
});
