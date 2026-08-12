import { app, BrowserWindow, ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  AddMachineConnectionRequest,
  ConnectionId,
  ConnectionSnapshot
} from '@shared/types/connections.js';
import { ConnectionRegistry } from '../connections/ConnectionRegistry.js';
import { ipcInvoke } from './result.js';

interface ConnectionsIpcOptions {
  registry: ConnectionRegistry;
  getWindows: () => BrowserWindow[];
  relaunch?: () => void;
}

export class ConnectionsIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;

  constructor(private readonly options: ConnectionsIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;
    ipcMain.handle(IpcChannels.connections.get, () =>
      ipcInvoke(() => this.options.registry.get())
    );
    ipcMain.handle(IpcChannels.connections.refresh, () =>
      ipcInvoke(() => this.options.registry.refresh())
    );
    ipcMain.handle(
      IpcChannels.connections.add,
      (_event, request: AddMachineConnectionRequest) =>
        ipcInvoke(() => this.options.registry.add(request.endpoint))
    );
    ipcMain.handle(IpcChannels.connections.remove, (_event, id: ConnectionId) =>
      ipcInvoke(() => this.options.registry.remove(id))
    );
    ipcMain.handle(IpcChannels.connections.select, (_event, id: ConnectionId) =>
      ipcInvoke(async () => {
        const result = await this.options.registry.select(id);
        if (result.relaunching) {
          setTimeout(() => (this.options.relaunch ?? relaunchApplication)(), 50);
        }
        return result;
      })
    );
    this.detachListener = this.options.registry.onChange((snapshot) => {
      this.broadcast(snapshot);
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.connections.get);
    ipcMain.removeHandler(IpcChannels.connections.refresh);
    ipcMain.removeHandler(IpcChannels.connections.add);
    ipcMain.removeHandler(IpcChannels.connections.remove);
    ipcMain.removeHandler(IpcChannels.connections.select);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }

  private broadcast(snapshot: ConnectionSnapshot): void {
    for (const win of this.options.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.connections.change, snapshot);
      }
    }
  }
}

function relaunchApplication(): void {
  app.relaunch();
  app.quit();
}
