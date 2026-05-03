import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type { ProjectId } from '@shared/types/projects.js';
import type { NotesChangeEvent } from '@shared/types/notes.js';
import type { NotesStore } from '../notes/NotesStore.js';
import { ipcInvoke } from './result.js';

export interface NotesIpcOptions {
  store: NotesStore;
  getWindows: () => BrowserWindow[];
}

export class NotesIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;

  constructor(private readonly opts: NotesIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.notes.list, (_e, projectId: ProjectId) =>
      ipcInvoke(() => this.opts.store.list(projectId))
    );

    ipcMain.handle(IpcChannels.notes.read, (_e, projectId: ProjectId, filename: string) =>
      ipcInvoke(() => this.opts.store.read(projectId, filename))
    );

    ipcMain.handle(
      IpcChannels.notes.write,
      (_e, projectId: ProjectId, filename: string, content: string) =>
        ipcInvoke(() => this.opts.store.write(projectId, filename, content))
    );

    ipcMain.handle(
      IpcChannels.notes.rename,
      (_e, projectId: ProjectId, oldName: string, newName: string) =>
        ipcInvoke(() => this.opts.store.rename(projectId, oldName, newName))
    );

    ipcMain.handle(IpcChannels.notes.delete, (_e, projectId: ProjectId, filename: string) =>
      ipcInvoke(async () => {
        await this.opts.store.delete(projectId, filename);
        return true as const;
      })
    );

    this.detachListener = this.opts.store.onChange((event: NotesChangeEvent) => {
      for (const win of this.opts.getWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannels.notes.change, event);
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.notes.list);
    ipcMain.removeHandler(IpcChannels.notes.read);
    ipcMain.removeHandler(IpcChannels.notes.write);
    ipcMain.removeHandler(IpcChannels.notes.rename);
    ipcMain.removeHandler(IpcChannels.notes.delete);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }
}
