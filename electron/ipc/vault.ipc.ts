import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  VaultChangeEvent,
  VaultDeleteRequest,
  VaultGetSecretRequest,
  VaultListRequest,
  VaultSaveRequest,
  VaultUpdateRequest
} from '@shared/types/vault.js';
import type { VaultStore } from '../vault/VaultStore.js';
import { ipcInvoke } from './result.js';

interface VaultIpcOptions {
  store: VaultStore;
  getWindows: () => Array<{
    isDestroyed(): boolean;
    webContents: { send(channel: string, payload: unknown): void };
  }>;
}

export class VaultIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;
  private readonly store: VaultStore;
  private readonly getWindows: VaultIpcOptions['getWindows'];

  constructor(options: VaultIpcOptions) {
    this.store = options.store;
    this.getWindows = options.getWindows;
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.vault.list, (_event, request: VaultListRequest) =>
      ipcInvoke(() => this.store.list(request.cwd))
    );
    ipcMain.handle(IpcChannels.vault.save, (_event, request: VaultSaveRequest) =>
      ipcInvoke(() => this.store.save(request.cwd, request.draft))
    );
    ipcMain.handle(IpcChannels.vault.update, (_event, request: VaultUpdateRequest) =>
      ipcInvoke(() => this.store.update(request.cwd, request.id, request.patch))
    );
    ipcMain.handle(IpcChannels.vault.delete, (_event, request: VaultDeleteRequest) =>
      ipcInvoke(async () => {
        await this.store.delete(request.cwd, request.id);
        return true as const;
      })
    );
    ipcMain.handle(IpcChannels.vault.getSecret, (_event, request: VaultGetSecretRequest) =>
      ipcInvoke(() => this.store.getSecret(request.cwd, request.id))
    );
    this.detachListener = this.store.onChange((event: VaultChangeEvent) => {
      for (const win of this.getWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannels.vault.change, event);
        }
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.vault.list);
    ipcMain.removeHandler(IpcChannels.vault.save);
    ipcMain.removeHandler(IpcChannels.vault.update);
    ipcMain.removeHandler(IpcChannels.vault.delete);
    ipcMain.removeHandler(IpcChannels.vault.getSecret);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }
}
