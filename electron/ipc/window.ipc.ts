import { BrowserWindow, ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import { ipcInvoke } from './result.js';

export class WindowIpc {
  private registered = false;

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.window.minimize, (event) =>
      ipcInvoke(() => {
        BrowserWindow.fromWebContents(event.sender)?.minimize();
        return true;
      })
    );
    ipcMain.handle(IpcChannels.window.toggleMaximize, (event) =>
      ipcInvoke(() => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win?.isMaximized()) {
          win.unmaximize();
        } else {
          win?.maximize();
        }
        return true;
      })
    );
    ipcMain.handle(IpcChannels.window.close, (event) =>
      ipcInvoke(() => {
        BrowserWindow.fromWebContents(event.sender)?.close();
        return true;
      })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.window.minimize);
    ipcMain.removeHandler(IpcChannels.window.toggleMaximize);
    ipcMain.removeHandler(IpcChannels.window.close);
    this.registered = false;
  }
}
