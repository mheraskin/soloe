import type { Project, ProjectDraft } from '@shared/types/projects.js';

export interface ProjectModalDraft extends ProjectDraft {}

class ProjectModalStore {
  open = $state(false);
  draft = $state<ProjectModalDraft>({ name: '', path: '' });
  editingId = $state<string | null>(null);
  error = $state<string | null>(null);

  openEdit(project: Project): void {
    this.editingId = project.id;
    this.draft = {
      name: project.name,
      path: project.path,
      ...(project.defaultRunMode ? { defaultRunMode: project.defaultRunMode } : {}),
      ...(project.defaultWslDistro ? { defaultWslDistro: project.defaultWslDistro } : {}),
      ...(project.accentColor ? { accentColor: project.accentColor } : {})
    };
    this.error = null;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.error = null;
  }
}

export const projectModal = new ProjectModalStore();
