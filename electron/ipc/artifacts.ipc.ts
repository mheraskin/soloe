import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  ArtifactProjectRef,
  ArtifactsChangeEvent
} from '@shared/types/artifacts.js';
import type { Project } from '@shared/types/projects.js';
import type { ArtifactStore } from '../artifacts/ArtifactStore.js';
import { ipcInvoke } from './result.js';

export interface ArtifactsIpcOptions {
  store: ArtifactStore;
  projects: { get(id: string): Promise<Project | null> };
  getWindows: () => BrowserWindow[];
}

export class ArtifactsIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;

  constructor(private readonly options: ArtifactsIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;
    ipcMain.handle(IpcChannels.artifacts.list, (_event, project: ArtifactProjectRef) =>
      ipcInvoke(async () => this.options.store.list(await this.requireProject(project)))
    );
    ipcMain.handle(
      IpcChannels.artifacts.read,
      (_event, project: ArtifactProjectRef, artifactId: string) =>
        ipcInvoke(async () => this.options.store.read(await this.requireProject(project), artifactId))
    );
    ipcMain.handle(
      IpcChannels.artifacts.delete,
      (_event, project: ArtifactProjectRef, artifactId: string) =>
        ipcInvoke(async () => this.options.store.delete(await this.requireProject(project), artifactId))
    );
    this.detachListener = this.options.store.onChange((event: ArtifactsChangeEvent) => {
      for (const window of this.options.getWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IpcChannels.artifacts.change, event);
        }
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.artifacts.list);
    ipcMain.removeHandler(IpcChannels.artifacts.read);
    ipcMain.removeHandler(IpcChannels.artifacts.delete);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }

  private async requireProject(input: ArtifactProjectRef): Promise<ArtifactProjectRef> {
    if (!input || typeof input.id !== 'string') throw new Error('Project is required');
    const project = await this.options.projects.get(input.id);
    if (!project) throw new Error(`Project not found: ${input.id}`);
    return { id: project.id, name: project.name };
  }
}

