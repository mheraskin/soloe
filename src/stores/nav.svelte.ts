import type { Session, SessionId } from '@shared/types/sessions.js';
import type { ProjectId } from '@shared/types/projects.js';
import { sessions } from './sessions.svelte';
import { projects } from './projects.svelte';
import { git } from './git.svelte';
import { sidebarExpansion } from './sidebar-expansion.svelte';
import { reportError } from './toast.svelte';
import { confirmDeleteSession } from '../lib/session-delete-confirmation';

function normPath(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

function basename(p: string): string {
  const parts = normPath(p).split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function worktreeLabel(projectPath: string, cwd: string): string {
  const projectRoot = normPath(projectPath);
  const worktreePath = normPath(cwd);
  if (worktreePath === projectRoot) return 'main';
  if (worktreePath.startsWith(projectRoot + '/') || worktreePath.startsWith(projectRoot + '\\')) {
    return worktreePath.slice(projectRoot.length + 1);
  }
  return basename(worktreePath);
}

const STANDALONE_KEY = '__standalone__';
const HINT_LIMIT = 9;

export interface WorktreeIndexTarget {
  projectId: ProjectId;
  cwd: string;
  label: string;
  branch?: string;
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
      const naturalOrder: string[] = [];
      const buckets: Record<string, Session[]> = {};
      const gitWorktrees = project ? git.worktreesFor(project.path) ?? [] : [];
      for (const wt of gitWorktrees) {
        const k = normPath(wt.path);
        if (!buckets[k]) {
          buckets[k] = [];
          naturalOrder.push(k);
        }
      }
      for (const s of list) {
        const k = normPath(s.cwd);
        if (!buckets[k]) {
          buckets[k] = [];
          naturalOrder.push(k);
        }
        buckets[k].push(s);
      }
      const userOrder = (project?.worktreeOrder ?? []).map(normPath);
      const seen = new Set<string>();
      const finalOrder: string[] = [];
      for (const key of userOrder) {
        if (buckets[key] && !seen.has(key)) {
          seen.add(key);
          finalOrder.push(key);
        }
      }
      for (const key of naturalOrder) {
        if (!seen.has(key)) {
          seen.add(key);
          finalOrder.push(key);
        }
      }
      for (const k of finalOrder) {
        for (const s of buckets[k]!) out.push(s);
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

    const buckets = new Map<string, { firstSessionId: SessionId | null }>();
    const naturalOrder: string[] = [];
    function ensureBucket(path: string): { firstSessionId: SessionId | null } {
      const key = normPath(path);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { firstSessionId: null };
        buckets.set(key, bucket);
        naturalOrder.push(key);
      }
      return bucket;
    }

    const gitWorktrees = git.worktreesFor(project.path) ?? [];
    for (const wt of gitWorktrees) {
      ensureBucket(wt.path);
    }
    for (const s of sessions.byProject[project.id] ?? []) {
      const bucket = ensureBucket(s.cwd);
      bucket.firstSessionId ??= s.id;
    }

    const userOrder = (project.worktreeOrder ?? []).map(normPath);
    const seen = new Set<string>();
    const finalOrder: string[] = [];
    for (const key of userOrder) {
      if (buckets.has(key) && !seen.has(key)) {
        seen.add(key);
        finalOrder.push(key);
      }
    }
    for (const key of naturalOrder) {
      if (!seen.has(key)) {
        seen.add(key);
        finalOrder.push(key);
      }
    }

    return finalOrder.map((cwd) => {
      const gitWorktree = gitWorktrees.find((wt) => normPath(wt.path) === cwd);
      return {
        projectId,
        cwd,
        label: gitWorktree?.branch
          ?? (gitWorktree?.detached ? 'detached' : worktreeLabel(project.path, cwd)),
        ...(gitWorktree?.branch ? { branch: gitWorktree.branch } : {}),
        firstSessionId: buckets.get(cwd)?.firstSessionId ?? null
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
