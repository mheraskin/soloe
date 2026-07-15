import type { Session, SessionId } from '@shared/types/sessions.js';
import type { ProjectId } from '@shared/types/projects.js';
import { sessions } from './sessions.svelte';
import { projects } from './projects.svelte';
import { git } from './git.svelte';
import { sidebarExpansion } from './sidebar-expansion.svelte';
import { reportError } from './toast.svelte';
import { confirmDeleteSession } from '../lib/session-delete-confirmation';
import { buildWorktreeGroups } from '../lib/worktree-groups';

const STANDALONE_KEY = '__standalone__';
const HINT_LIMIT = 9;

export interface WorktreeIndexTarget {
  projectId: ProjectId;
  cwd: string;
  label: string;
  branch?: string;
  selectedSessionId: SessionId | null;
  firstSessionId: SessionId | null;
}

class NavStore {
  flat = $derived.by<Session[]>(() => {
    const grouped = sessions.byProject;
    const present = new Set(sessions.projectIds);
    const projectOrder: string[] = [];
    for (const p of projects.recents) {
      if (present.has(p.id)) projectOrder.push(p.id);
    }
    for (const id of sessions.projectIds) {
      if (!projectOrder.includes(id)) projectOrder.push(id);
    }

    const out: Session[] = [...sessions.standalone];
    for (const projectKey of projectOrder) {
      const list = grouped[projectKey] ?? [];
      const project = projects.get(projectKey as ProjectId);
      // Build the natural order the same way ProjectSection does: git worktrees
      // first (so empty worktrees still seed the order), then any session cwds
      // that aren't git worktrees. Without the git-worktrees seed, the Ctrl+N
      // numbering doesn't match what the user sees in the sidebar.
      const gitWorktrees = project ? git.worktreesFor(project.path, {
        ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
        ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
      }) ?? [] : [];
      const worktreeGroups = buildWorktreeGroups({
        projectPath: project?.path ?? '',
        ...(project?.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
        worktrees: gitWorktrees,
        items: list,
        orderedPaths: project?.worktreeOrder ?? []
      });
      for (const group of worktreeGroups) {
        for (const session of group.items) out.push(session);
      }
    }
    return out;
  });

  activeProjectId = $derived<ProjectId | null>(sessions.selected?.projectId ?? null);

  // Only the sessions that are actually visible in the sidebar — i.e. live in
  // an expanded worktree group. Sessions in collapsed worktrees are dropped so
  // the Ctrl+1..9 numbering renumbers to what the user can actually see.
  // Standalone sessions (no projectId) aren't grouped by a WorktreeGroup, so
  // there's nothing to collapse there and they always pass through.
  flatActiveProject = $derived.by<Session[]>(() => {
    const projectId = this.activeProjectId;
    const all = this.flat;
    if (!projectId) return all.filter((s) => !s.projectId);
    return all.filter(
      (s) => s.projectId === projectId && !sidebarExpansion.isCollapsed(s.cwd)
    );
  });

  activeIndex = $derived.by<number>(() => {
    const id = sessions.selectedId;
    if (!id) return -1;
    return this.flatActiveProject.findIndex((s) => s.id === id);
  });

  sessionIndexHints = $derived.by<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    const list = this.flatActiveProject;
    for (let i = 0; i < Math.min(HINT_LIMIT, list.length); i += 1) {
      out[list[i]!.id] = i + 1;
    }
    return out;
  });

  activeProjectWorktrees = $derived.by<WorktreeIndexTarget[]>(() => {
    const projectId = this.activeProjectId;
    if (!projectId) return [];
    const project = projects.get(projectId);
    if (!project) return [];

    const gitWorktrees = git.worktreesFor(project.path, {
      ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
      ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
    }) ?? [];
    const groups = buildWorktreeGroups({
      projectPath: project.path,
      ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
      worktrees: gitWorktrees,
      items: sessions.byProject[project.id] ?? [],
      orderedPaths: project.worktreeOrder ?? []
    });
    return groups.map((group) => {
      const firstSessionId = group.items[0]?.id ?? null;
      return {
        projectId,
        cwd: group.cwd,
        label: group.label,
        ...(group.worktree?.branch ? { branch: group.worktree.branch } : {}),
        selectedSessionId: sessions.lastSelectedIdForWorktree({ projectId, cwd: group.cwd })
          ?? firstSessionId,
        firstSessionId
      };
    });
  });

  worktreeIndexHints = $derived.by<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    const list = this.activeProjectWorktrees;
    for (let i = 0; i < Math.min(HINT_LIMIT, list.length); i += 1) {
      out[list[i]!.cwd] = i + 1;
    }
    return out;
  });

  selectByIndex(n: number): void {
    const list = this.flatActiveProject;
    const target = list[n];
    if (target) sessions.select(target.id);
  }

  worktreeByIndex(n: number): WorktreeIndexTarget | null {
    return this.activeProjectWorktrees[n] ?? null;
  }

  focusProject(projectId: ProjectId): void {
    const lastSelected = sessions.lastSelectedByProject[projectId];
    if (lastSelected && sessions.sessions.some((s) => s.id === lastSelected)) {
      sessions.select(lastSelected);
      return;
    }
    const first = (sessions.byProject[projectId] ?? [])[0];
    if (first) sessions.select(first.id);
  }

  cycleNext(): void {
    const list = this.flat;
    if (list.length === 0) return;
    const idx = list.findIndex((s) => s.id === sessions.selectedId);
    const next = idx < 0 ? 0 : (idx + 1) % list.length;
    sessions.select(list[next]!.id);
  }

  cyclePrev(): void {
    const list = this.flat;
    if (list.length === 0) return;
    const idx = list.findIndex((s) => s.id === sessions.selectedId);
    const next = idx <= 0 ? list.length - 1 : idx - 1;
    sessions.select(list[next]!.id);
  }

  async closeActive(): Promise<void> {
    const id = sessions.selectedId;
    if (!id) return;
    const session = sessions.sessions.find((s) => s.id === id);
    if (!session) return;
    // Keyboard-shortcut path: ignore the user's "don't ask again" preference so
    // a stray Ctrl+Delete can't silently destroy a session.
    const ok = await confirmDeleteSession(session, { alwaysConfirm: true });
    if (!ok) return;
    try {
      await sessions.remove(id);
    } catch (err) {
      reportError(err);
    }
  }
}

export const nav = new NavStore();
export { STANDALONE_KEY };
