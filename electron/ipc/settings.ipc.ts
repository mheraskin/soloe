import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type { Settings, SettingsUpdate } from '@shared/types/settings.js';
import type { SettingsStore } from '../settings/SettingsStore.js';
import { ipcInvoke } from './result.js';

export interface SettingsIpcOptions {
  store: SettingsStore;
  getWindows: () => BrowserWindow[];
}

export class SettingsIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;

  constructor(private readonly opts: SettingsIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.settings.get, () =>
      ipcInvoke(() => this.opts.store.get())
    );

    ipcMain.handle(IpcChannels.settings.update, (_e, patch: SettingsUpdate) =>
      ipcInvoke(() => this.opts.store.update(patch))
    );

    this.detachListener = this.opts.store.onChange((s: Settings) => {
      for (const win of this.opts.getWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannels.settings.change, s);
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.settings.get);
    ipcMain.removeHandler(IpcChannels.settings.update);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }
}
