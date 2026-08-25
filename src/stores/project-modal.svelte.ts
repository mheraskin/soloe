import type { Project, ProjectDraft } from '@shared/types/projects.js';
import type { ProjectRef } from '@shared/types/devices.js';

export interface ProjectModalDraft extends ProjectDraft {}

class ProjectModalStore {
  open = $state(false);
  draft = $state<ProjectModalDraft>({ name: '', path: '' });
  editingId = $state<string | null>(null);
  deviceTarget = $state<ProjectRef | null>(null);
  deviceName = $state<string | null>(null);
  error = $state<string | null>(null);

  openEdit(project: Project, deviceTarget: ProjectRef | null = null, deviceName: string | null = null): void {
    this.editingId = project.id;
    this.deviceTarget = deviceTarget ? structuredClone(deviceTarget) : null;
    this.deviceName = deviceName;
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
    this.deviceTarget = null;
    this.deviceName = null;
    this.error = null;
  }
}

export const projectModal = new ProjectModalStore();
