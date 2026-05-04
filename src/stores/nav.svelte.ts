import type { Session, SessionId } from '@shared/types/sessions.js';
import type { ProjectId } from '@shared/types/projects.js';
import { sessions } from './sessions.svelte';
import { projects } from './projects.svelte';
import { reportError } from './toast.svelte';
import { confirmDeleteSession } from '../lib/session-delete-confirmation';

function normPath(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

const STANDALONE_KEY = '__standalone__';
const HINT_LIMIT = 9;

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
      const cwdOrder: string[] = [];
      const buckets: Record<string, Session[]> = {};
      for (const s of list) {
        const k = normPath(s.cwd);
        if (!buckets[k]) {
          buckets[k] = [];
          cwdOrder.push(k);
        }
        buckets[k].push(s);
      }
      const project = projects.get(projectKey as ProjectId);
      const userOrder = (project?.worktreeOrder ?? []).map(normPath);
      const seen = new Set<string>();
      const finalOrder: string[] = [];
      for (const key of userOrder) {
        if (buckets[key] && !seen.has(key)) {
          seen.add(key);
          finalOrder.push(key);
        }
      }
      for (const key of cwdOrder) {
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

  flatActiveProject = $derived.by<Session[]>(() => {
    const projectId = this.activeProjectId;
    const all = this.flat;
    if (!projectId) return all.filter((s) => !s.projectId);
    return all.filter((s) => s.projectId === projectId);
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

  projectIndexHints = $derived.by<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    const list = projects.recents;
    for (let i = 0; i < Math.min(HINT_LIMIT, list.length); i += 1) {
      out[list[i]!.id] = i + 1;
    }
    return out;
  });

  selectByIndex(n: number): void {
    const list = this.flatActiveProject;
    const target = list[n];
    if (target) sessions.select(target.id);
  }

  selectProjectByIndex(n: number): void {
    const project = projects.recents[n];
    if (!project) return;
    this.focusProject(project.id);
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
    const ok = await confirmDeleteSession(session);
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
