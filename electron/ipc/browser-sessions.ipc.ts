import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type { BrowserSessionUpdateRequest } from '@shared/types/browser-sessions.js';
import type { BrowserSessionStore } from '../browser/BrowserSessionStore.js';
import { ipcInvoke } from './result.js';

export class BrowserSessionsIpc {
  private registered = false;

  constructor(private readonly store: BrowserSessionStore) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;
    ipcMain.handle(IpcChannels.browserSessions.get, () =>
      ipcInvoke(() => this.store.get())
    );
    ipcMain.handle(
      IpcChannels.browserSessions.update,
      (_event, request: BrowserSessionUpdateRequest) =>
        ipcInvoke(() => this.store.update(request))
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.browserSessions.get);
    ipcMain.removeHandler(IpcChannels.browserSessions.update);
    this.registered = false;
  }
}
