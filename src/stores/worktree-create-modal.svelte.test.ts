/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { suggestedWorktreePath, worktreeCreateModal } from './worktree-create-modal.svelte';

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

describe('worktreeCreateModal', () => {
  it('keeps the target Device on the draft and creation notice', () => {
    worktreeCreateModal.openFor({
      id: 'project-remote',
      name: 'Soloe',
      path: '/srv/soloe',
      defaultRunMode: 'linux',
      createdAt: '2026-08-28T09:00:00.000Z',
      lastOpenedAt: '2026-08-28T09:00:00.000Z'
    }, 'main', {
      deviceId: 'device-xps',
      deviceName: 'xps'
    });

    expect(worktreeCreateModal.draft).toMatchObject({
      projectId: 'project-remote',
      repoPath: '/srv/soloe',
      baseRef: 'main',
      deviceId: 'device-xps',
      deviceName: 'xps'
    });

    worktreeCreateModal.recordCreated('/srv/soloe-feature');
    expect(worktreeCreateModal.created).toEqual({
      projectId: 'project-remote',
      path: '/srv/soloe-feature',
      deviceId: 'device-xps'
    });
    worktreeCreateModal.close();
  });
});
