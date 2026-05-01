import type { Project, ProjectDraft } from '@shared/types/projects.js';
import { settings } from './settings.svelte';

export type ProjectModalMode = 'new' | 'edit';

export interface ProjectModalDraft extends ProjectDraft {}

function freshDraft(): ProjectModalDraft {
  const defaults = settings.current.defaults;
  return {
    name: '',
    path: '',
    defaultRunMode: defaults.runMode,
    ...(defaults.runMode === 'wsl' && defaults.wslDistro ? { defaultWslDistro: defaults.wslDistro } : {})
  };
}

class ProjectModalStore {
  open = $state(false);
  mode = $state<ProjectModalMode>('new');
  draft = $state<ProjectModalDraft>(freshDraft());
  editingId = $state<string | null>(null);
  error = $state<string | null>(null);
  onCreated: ((project: Project) => void) | null = null;

  openNew(prefill?: Partial<ProjectModalDraft>, onCreated?: (p: Project) => void): void {
    this.mode = 'new';
    this.editingId = null;
    this.draft = { ...freshDraft(), ...(prefill ?? {}) };
    this.error = null;
    this.onCreated = onCreated ?? null;
    this.open = true;
  }

  openEdit(project: Project): void {
    this.mode = 'edit';
    this.editingId = project.id;
    this.draft = {
      name: project.name,
      path: project.path,
      ...(project.defaultRunMode ? { defaultRunMode: project.defaultRunMode } : {}),
      ...(project.defaultWslDistro ? { defaultWslDistro: project.defaultWslDistro } : {}),
      ...(project.accentColor ? { accentColor: project.accentColor } : {})
    };
    this.error = null;
    this.onCreated = null;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.error = null;
    this.onCreated = null;
  }
}

export const projectModal = new ProjectModalStore();
