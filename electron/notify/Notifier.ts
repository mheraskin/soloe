import type { BrowserWindow } from 'electron';
import { IpcChannels, type ToastNotification } from '@shared/types/ipc.js';

export interface NotifierOptions {
  getWindows: () => BrowserWindow[];
}

export class Notifier {
  constructor(private readonly opts: NotifierOptions) {}

  toast(notification: ToastNotification): void {
    for (const win of this.opts.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.notify.toast, notification);
      }
    }
  }
}
