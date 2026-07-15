import {
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  FeatureChangeEvent,
  FeatureScanRequest,
  FeatureSetBranchStatusRequest,
  FeatureSetIssueStatusRequest
} from '@shared/types/features.js';
import { worktreeIdentityKey } from '@shared/worktree-identity.js';
import type { FeatureService } from '../features/FeatureService.js';
import type {
  FeatureArtifactObservation,
  FeatureArtifactScope
} from '../features/FeatureArtifactObservation.js';
import { ipcInvoke } from './result.js';

export interface FeaturesIpcOptions {
  service: FeatureService;
  observation: FeatureArtifactObservation;
}

interface ActiveSubscription {
  release: () => void;
}

interface SubscriptionOwner {
  sender: WebContents;
  active: Map<string, ActiveSubscription>;
  onDestroyed: () => void;
}

export class FeaturesIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;
  // Each renderer owns its subscriptions. A reload or destroyed window
  // releases everything automatically, while a second window can subscribe to
  // the same worktree without replacing the first window's ownership.
  private owners = new Map<number, SubscriptionOwner>();

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
      (event, request: { cwd: string; runMode: 'windows' | 'wsl'; wslDistro?: string }) =>
        ipcInvoke(async () => {
          const owner = this.ownerFor(event);
          const id = this.subscriptionId(request);
          owner.active.get(id)?.release();
          const release = this.opts.observation.acquire(request);
          owner.active.set(id, { release });
          return true as const;
        })
    );

    ipcMain.handle(
      IpcChannels.features.unsubscribe,
      (event, request: { cwd: string; runMode: 'windows' | 'wsl'; wslDistro?: string }) =>
        ipcInvoke(async () => {
          const id = this.subscriptionId(request);
          const owner = this.owners.get(event.sender.id);
          owner?.active.get(id)?.release();
          owner?.active.delete(id);
          return true as const;
        })
    );

    this.detachListener = this.opts.observation.onChange((event: FeatureChangeEvent) => {
      const id = this.subscriptionId(event);
      for (const owner of this.owners.values()) {
        if (owner.active.has(id) && !owner.sender.isDestroyed()) {
          owner.sender.send(IpcChannels.features.change, event);
        }
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
    for (const ownerId of [...this.owners.keys()]) this.releaseOwner(ownerId);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }

  private subscriptionId(scope: FeatureArtifactScope): string {
    return worktreeIdentityKey(scope.cwd, scope);
  }

  private ownerFor(event: IpcMainInvokeEvent): SubscriptionOwner {
    const ownerId = event.sender.id;
    const existing = this.owners.get(ownerId);
    if (existing) return existing;
    const onDestroyed = () => this.releaseOwner(ownerId);
    const owner: SubscriptionOwner = {
      sender: event.sender,
      active: new Map(),
      onDestroyed
    };
    this.owners.set(ownerId, owner);
    event.sender.once('destroyed', onDestroyed);
    return owner;
  }

  private releaseOwner(ownerId: number): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    this.owners.delete(ownerId);
    if (!owner.sender.isDestroyed()) {
      owner.sender.removeListener('destroyed', owner.onDestroyed);
    }
    for (const subscription of owner.active.values()) subscription.release();
    owner.active.clear();
  }
}
