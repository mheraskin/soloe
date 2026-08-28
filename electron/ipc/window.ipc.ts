import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import { ipcInvoke } from './result.js';

const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.8;

export class WindowIpc {
  private registered = false;

  constructor(private readonly opts: {
    openSessionEventsDebug?: () => void | Promise<void>;
  } = {}) {}

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
    ipcMain.handle(IpcChannels.window.zoomIn, (event) =>
      ipcInvoke(() => setZoom(event, ZOOM_STEP))
    );
    ipcMain.handle(IpcChannels.window.zoomOut, (event) =>
      ipcInvoke(() => setZoom(event, -ZOOM_STEP))
    );
    ipcMain.handle(IpcChannels.window.openSessionEventsDebug, () =>
      ipcInvoke(async () => {
        await this.opts.openSessionEventsDebug?.();
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
    ipcMain.removeHandler(IpcChannels.window.zoomIn);
    ipcMain.removeHandler(IpcChannels.window.zoomOut);
    ipcMain.removeHandler(IpcChannels.window.openSessionEventsDebug);
    ipcMain.removeHandler(IpcChannels.window.close);
    this.registered = false;
  }
}

function setZoom(event: IpcMainInvokeEvent, delta: number): number {
  const webContents = event.sender;
  const current = webContents.getZoomFactor();
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current + delta));
  const rounded = Math.round(next * 100) / 100;
  webContents.setZoomFactor(rounded);
  return rounded;
}
