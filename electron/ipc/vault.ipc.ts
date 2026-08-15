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

type VaultIpcStore = Pick<
  VaultStore,
  'list' | 'save' | 'update' | 'delete' | 'getSecret' | 'onChange'
>;

interface VaultIpcOptions {
  store?: VaultIpcStore;
  createStore?: () => VaultIpcStore | Promise<VaultIpcStore>;
  getWindows: () => Array<{
    isDestroyed(): boolean;
    webContents: { send(channel: string, payload: unknown): void };
  }>;
}

export class VaultIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;
  private storePromise: Promise<VaultIpcStore> | null = null;
  private readonly createStore: () => VaultIpcStore | Promise<VaultIpcStore>;
  private readonly getWindows: VaultIpcOptions['getWindows'];

  constructor(options: VaultIpcOptions) {
    if (options.store && options.createStore) {
      throw new Error('VaultIpc accepts either store or createStore, not both');
    }
    if (!options.store && !options.createStore) {
      throw new Error('VaultIpc requires store or createStore');
    }
    this.createStore = options.createStore ?? (() => options.store!);
    this.getWindows = options.getWindows;
  }

  private getStore(): Promise<VaultIpcStore> {
    if (this.storePromise) return this.storePromise;

    const pending = Promise.resolve()
      .then(() => this.createStore())
      .then((store) => {
        if (this.registered && !this.detachListener) {
          this.detachListener = store.onChange((event: VaultChangeEvent) => {
            for (const win of this.getWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send(IpcChannels.vault.change, event);
              }
            }
          });
        }
        return store;
      })
      .catch((error) => {
        if (this.storePromise === pending) this.storePromise = null;
        throw error;
      });
    this.storePromise = pending;
    return pending;
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.vault.list, (_event, request: VaultListRequest) =>
      ipcInvoke(async () => (await this.getStore()).list(request.cwd))
    );
    ipcMain.handle(IpcChannels.vault.save, (_event, request: VaultSaveRequest) =>
      ipcInvoke(async () => (await this.getStore()).save(request.cwd, request.draft))
    );
    ipcMain.handle(IpcChannels.vault.update, (_event, request: VaultUpdateRequest) =>
      ipcInvoke(async () => (await this.getStore()).update(request.cwd, request.id, request.patch))
    );
    ipcMain.handle(IpcChannels.vault.delete, (_event, request: VaultDeleteRequest) =>
      ipcInvoke(async () => {
        await (await this.getStore()).delete(request.cwd, request.id);
        return true as const;
      })
    );
    ipcMain.handle(IpcChannels.vault.getSecret, (_event, request: VaultGetSecretRequest) =>
      ipcInvoke(async () => (await this.getStore()).getSecret(request.cwd, request.id))
    );
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
    this.storePromise = null;
    this.registered = false;
  }
}
