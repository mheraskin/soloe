import type {
  Project,
  ProjectDetectResult,
  ProjectDraft,
  ProjectFavicon,
  ProjectId,
  ProjectOpenRequest,
  ProjectSuggestOptions,
  ProjectSuggestResult,
  ProjectUpdate
} from '@shared/types/projects.js';
import { ipc } from '../lib/ipc';

class ProjectsStore {
  projects = $state<Project[]>([]);
  loaded = $state(false);
  // Set when the renderer just added a project so the sidebar can center-scroll
  // to it. Cleared after consumed.
  newlyAddedId = $state<ProjectId | null>(null);

  byId = $derived.by<Record<ProjectId, Project>>(() => {
    const out: Record<ProjectId, Project> = {};
    for (const p of this.projects) out[p.id] = p;
    return out;
  });

  // User-controlled order: sortIndex ASC, with createdAt as tiebreaker. The
  // legacy `recents` name is kept so existing callers (nav store) keep working
  // — semantics changed from "most recently opened first" to "user order".
  recents = $derived([...this.projects].sort(compareProjects));

  private detachers: Array<() => void> = [];

  async load(): Promise<void> {
    const list = await ipc.projects.list();
    this.projects = list;
    this.loaded = true;
  }

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.projects.onChange((projects) => {
        this.projects = projects;
      })
    );
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }

  get(id: ProjectId | null | undefined): Project | null {
    if (!id) return null;
    return this.byId[id] ?? null;
  }

  async create(draft: ProjectDraft): Promise<Project> {
    const created = await ipc.projects.create(draft);
    this.projects = [...this.projects.filter((p) => p.id !== created.id), created];
    this.newlyAddedId = created.id;
    return created;
  }

  async open(request: ProjectOpenRequest): Promise<Project> {
    const opened = await ipc.projects.open(request);
    const existed = this.projects.some((p) => p.id === opened.id);
    this.projects = [...this.projects.filter((p) => p.id !== opened.id), opened];
    // Only flag newly-added (not re-opened) projects so the sidebar doesn't
    // jump every time the user revisits an existing project.
    if (!existed) this.newlyAddedId = opened.id;
    return opened;
  }

  async update(id: ProjectId, patch: ProjectUpdate): Promise<Project> {
    const updated = await ipc.projects.update(id, patch);
    this.projects = this.projects.map((p) => (p.id === id ? updated : p));
    return updated;
  }

  async remove(id: ProjectId): Promise<void> {
    await ipc.projects.delete(id);
    this.projects = this.projects.filter((p) => p.id !== id);
  }

  async touch(id: ProjectId): Promise<void> {
    const touched = await ipc.projects.touch(id);
    if (touched) {
      this.projects = this.projects.map((p) => (p.id === id ? touched : p));
    }
  }

  async reorder(orderedIds: ProjectId[]): Promise<void> {
    const list = await ipc.projects.reorder(orderedIds);
    this.projects = list;
  }

  async refreshFavicons(id: ProjectId): Promise<ProjectFavicon[]> {
    return ipc.projects.refreshFavicons(id);
  }

  async readFavicon(id: ProjectId, relativePath: string): Promise<ProjectFavicon | null> {
    return ipc.projects.readFavicon(id, relativePath);
  }

  consumeNewlyAdded(id: ProjectId): void {
    if (this.newlyAddedId === id) this.newlyAddedId = null;
  }

  async detectFromPath(path: string): Promise<ProjectDetectResult> {
    return ipc.projects.detectFromPath(path);
  }

  async suggestPaths(
    query: string,
    options?: ProjectSuggestOptions
  ): Promise<ProjectSuggestResult> {
    return ipc.projects.suggestPaths(query, options);
  }
}

export const projects = new ProjectsStore();

function compareProjects(a: Project, b: Project): number {
  const ai = sortKey(a);
  const bi = sortKey(b);
  if (ai !== bi) return ai - bi;
  return a.createdAt.localeCompare(b.createdAt);
}

function sortKey(p: Project): number {
  return Number.isFinite(p.sortIndex) ? (p.sortIndex as number) : Number.MAX_SAFE_INTEGER;
}
