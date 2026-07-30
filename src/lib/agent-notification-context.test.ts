import { describe, expect, it } from 'vitest';
import type { Project } from '@shared/types/projects.js';
import type { Session } from '@shared/types/sessions.js';
import { agentNotificationBreadcrumb } from './agent-notification-context';

const project: Project = {
  id: 'project-1',
  name: 'Soloe',
  path: '/repo/soloe',
  createdAt: '2026-07-30T00:00:00.000Z',
  lastOpenedAt: '2026-07-30T00:00:00.000Z'
};

const session: Session = {
  id: 'session-1',
  projectId: project.id,
  name: 'amber',
  cwd: '/repo/soloe-worktrees/notifications',
  runMode: 'linux',
  lastBranch: 'fix/notifications',
  launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' },
  createdAt: '2026-07-30T00:00:00.000Z',
  lastUsedAt: '2026-07-30T00:00:00.000Z'
};

describe('agentNotificationBreadcrumb', () => {
  it('shows project, worktree, and session in order', () => {
    expect(agentNotificationBreadcrumb(session, project)).toEqual([
      'Soloe',
      'fix/notifications',
      'amber'
    ]);
  });

  it('falls back to the worktree folder when no branch is known', () => {
    expect(agentNotificationBreadcrumb({ ...session, lastBranch: undefined }, project)).toEqual([
      'Soloe',
      'notifications',
      'amber'
    ]);
  });
});
