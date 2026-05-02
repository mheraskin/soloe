import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  Project,
  ProjectDraft,
  ProjectId,
  ProjectOpenRequest,
  ProjectSuggestOptions,
  ProjectUpdate
} from '@shared/types/projects.js';
import type { ProjectStore } from '../projects/ProjectStore.js';
import { ipcInvoke } from './result.js';

export interface ProjectsIpcOptions {
  store: ProjectStore;
  getWindows: () => BrowserWindow[];
}

export class ProjectsIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;

  constructor(private readonly opts: ProjectsIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.projects.list, () =>
      ipcInvoke(() => this.opts.store.list())
    );

    ipcMain.handle(IpcChannels.projects.get, (_e, id: ProjectId) =>
      ipcInvoke(() => this.opts.store.get(id))
    );

    ipcMain.handle(IpcChannels.projects.create, (_e, d: ProjectDraft) =>
      ipcInvoke(() => this.opts.store.create(d))
    );

    ipcMain.handle(IpcChannels.projects.open, (_e, request: ProjectOpenRequest) =>
      ipcInvoke(() => this.opts.store.open(request))
    );

    ipcMain.handle(IpcChannels.projects.update, (_e, id: ProjectId, patch: ProjectUpdate) =>
      ipcInvoke(() => this.opts.store.update(id, patch))
    );

    ipcMain.handle(IpcChannels.projects.delete, (_e, id: ProjectId) =>
      ipcInvoke(async () => {
        await this.opts.store.delete(id);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.projects.touch, (_e, id: ProjectId) =>
      ipcInvoke(() => this.opts.store.touch(id))
    );

    ipcMain.handle(IpcChannels.projects.detectFromPath, (_e, p: string) =>
      ipcInvoke(() => this.opts.store.detectFromPath(p))
    );

    ipcMain.handle(
      IpcChannels.projects.suggestPaths,
      (_e, query: string, options?: ProjectSuggestOptions) =>
        ipcInvoke(() => this.opts.store.suggestPaths(query, options))
    );

    this.detachListener = this.opts.store.onChange((projects: Project[]) => {
      for (const win of this.opts.getWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannels.projects.change, projects);
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.projects.list);
    ipcMain.removeHandler(IpcChannels.projects.get);
    ipcMain.removeHandler(IpcChannels.projects.create);
    ipcMain.removeHandler(IpcChannels.projects.open);
    ipcMain.removeHandler(IpcChannels.projects.update);
    ipcMain.removeHandler(IpcChannels.projects.delete);
    ipcMain.removeHandler(IpcChannels.projects.touch);
    ipcMain.removeHandler(IpcChannels.projects.detectFromPath);
    ipcMain.removeHandler(IpcChannels.projects.suggestPaths);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }
}
