import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  FeatureChangeEvent,
  FeatureScanRequest,
  FeatureSetBranchStatusRequest,
  FeatureSetIssueStatusRequest
} from '@shared/types/features.js';
import type { FeatureService } from '../features/FeatureService.js';
import type { FeatureWatcher } from '../features/FeatureWatcher.js';
import { ipcInvoke } from './result.js';

export interface FeaturesIpcOptions {
  service: FeatureService;
  watcher: FeatureWatcher;
  getWindows: () => BrowserWindow[];
}

interface ActiveSubscription {
  release: () => void;
}

export class FeaturesIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;
  // Tracks the most recent subscribe call per `(cwd, runMode, wslDistro)` so a
  // renderer that re-subscribes (e.g. on remount) doesn't leak ref counts.
  private active = new Map<string, ActiveSubscription>();

  constructor(private readonly opts: FeaturesIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.features.scan, (_e, request: FeatureScanRequest) =>
      ipcInvoke(() => this.opts.service.scan(request))
    );

    ipcMain.handle(IpcChannels.features.setBranchStatus, (_e, request: FeatureSetBranchStatusRequest) =>
      ipcInvoke(() => this.opts.service.writeBranchStatus(request))
    );

    ipcMain.handle(IpcChannels.features.setIssueStatus, (_e, request: FeatureSetIssueStatusRequest) =>
      ipcInvoke(() => this.opts.service.writeIssueStatus(request))
    );

    ipcMain.handle(
      IpcChannels.features.subscribe,
      (_e, request: { cwd: string; runMode: 'windows' | 'wsl'; wslDistro?: string }) =>
        ipcInvoke(async () => {
          const id = this.subscriptionId(request);
          this.active.get(id)?.release();
          const release = this.opts.watcher.subscribe(request);
          this.active.set(id, { release });
          return true as const;
        })
    );

    ipcMain.handle(
      IpcChannels.features.unsubscribe,
      (_e, request: { cwd: string; runMode: 'windows' | 'wsl'; wslDistro?: string }) =>
        ipcInvoke(async () => {
          const id = this.subscriptionId(request);
          this.active.get(id)?.release();
          this.active.delete(id);
          return true as const;
        })
    );

    this.detachListener = this.opts.watcher.onChange((event: FeatureChangeEvent) => {
      for (const win of this.opts.getWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannels.features.change, event);
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.features.scan);
    ipcMain.removeHandler(IpcChannels.features.setBranchStatus);
    ipcMain.removeHandler(IpcChannels.features.setIssueStatus);
    ipcMain.removeHandler(IpcChannels.features.subscribe);
    ipcMain.removeHandler(IpcChannels.features.unsubscribe);
    for (const sub of this.active.values()) sub.release();
    this.active.clear();
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }

  private subscriptionId(req: { cwd: string; runMode: string; wslDistro?: string }): string {
    return `${req.runMode}::${req.wslDistro ?? ''}::${req.cwd}`;
  }
}
