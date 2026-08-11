import type { Project } from '@shared/types/projects.js';
import type { Session } from '@shared/types/sessions.js';
import { worktreeBasename, worktreeLabel } from './worktree-path';

export function agentNotificationBreadcrumb(
  session: Pick<Session, 'name' | 'cwd' | 'runMode' | 'lastBranch'>,
  project: Pick<Project, 'name' | 'path'> | null
): string[] {
  const worktree = session.lastBranch?.trim()
    || (
      project
        ? worktreeLabel(project.path, session.cwd, session.runMode)
        : worktreeBasename(session.cwd)
    );
  return [
    project?.name.trim() || null,
    worktree.trim() || null,
    session.name.trim() || '(unnamed)'
  ].filter((item): item is string => Boolean(item));
}
