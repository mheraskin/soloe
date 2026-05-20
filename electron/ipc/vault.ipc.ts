import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
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
}

export class VaultIpc {
  private registered = false;
  private readonly store: VaultStore;

  constructor(options: VaultIpcOptions) {
    this.store = options.store;
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
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.vault.list);
    ipcMain.removeHandler(IpcChannels.vault.save);
    ipcMain.removeHandler(IpcChannels.vault.update);
    ipcMain.removeHandler(IpcChannels.vault.delete);
    ipcMain.removeHandler(IpcChannels.vault.getSecret);
    this.registered = false;
  }
}
