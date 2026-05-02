import type {
  Project,
  ProjectDetectResult,
  ProjectDraft,
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

  byId = $derived.by<Record<ProjectId, Project>>(() => {
    const out: Record<ProjectId, Project> = {};
    for (const p of this.projects) out[p.id] = p;
    return out;
  });

  recents = $derived(
    [...this.projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
  );

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
    this.projects = [created, ...this.projects.filter((p) => p.id !== created.id)];
    return created;
  }

  async open(request: ProjectOpenRequest): Promise<Project> {
    const opened = await ipc.projects.open(request);
    this.projects = [opened, ...this.projects.filter((p) => p.id !== opened.id)];
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
