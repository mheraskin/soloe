import type {
  GitShortstat,
  GitStatus,
  GitWorktree,
  WorkingChangesResult,
  WorkingTreeSnapshot
} from '@shared/types/git.js';
import type { RunMode } from '@shared/types/sessions.js';
import type { DeviceId } from '@shared/types/devices.js';
import { worktreeIdentityKey, type WorktreeScope } from '@shared/worktree-identity.js';
import { ipc } from '../lib/ipc';
import { GroupedTaskPool } from '../lib/grouped-task-pool';
import {
  GitRefreshCoordinator,
  type GitRefreshCadence,
  type GitRefreshCause,
  type GitRefreshEvent,
  type GitRefreshIntent
} from '../lib/git-refresh-coordinator';

interface GitStatusEntry {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
}

interface GitShortstatEntry {
  shortstat: GitShortstat | null;
  loading: boolean;
  error: string | null;
}

interface GitWorktreesEntry {
  worktrees: GitWorktree[] | null;
  loading: boolean;
  error: string | null;
}

export interface WorktreePollIntent {
  cwd: string;
  cadence: GitRefreshCadence;
  runMode?: RunMode;
  wslDistro?: string;
  deviceId?: DeviceId;
}

export interface ProjectPollIntent {
  repoPath: string;
  cadence: GitRefreshCadence;
  runMode?: RunMode;
  wslDistro?: string;
  deviceId?: DeviceId;
}

export interface RepoContext {
  runMode?: RunMode;
  wslDistro?: string;
  deviceId?: DeviceId;
}

export interface WorktreeInventory {
  repoPath: string;
  worktrees: GitWorktree[];
  context: RepoContext;
}

const REFRESH_INTERVALS: Readonly<Record<GitRefreshCadence, number>> = {
  foreground: 5_000,
  background: 30_000
};
const INVENTORY_INTERVALS: Readonly<Record<GitRefreshCadence, number>> = {
  foreground: 60_000,
  background: 10 * 60_000
};

interface SessionIntent {
  cwd: string;
  cadence: GitRefreshCadence;
  ctx: RepoContext;
}

interface PollingContext extends RepoContext {
  cwd: string;
}

interface InventoryContext extends RepoContext {
  repoPath: string;
}

type GitObservationResult =
  | { cwd: string; context: RepoContext; snapshot: WorkingTreeSnapshot; error: null }
  | { cwd: string; context: RepoContext; snapshot: null; error: string };

class GitStore {
  statuses = $state<Record<string, GitStatusEntry>>({});
  shortstats = $state<Record<string, GitShortstatEntry>>({});
  worktrees = $state<Record<string, GitWorktreesEntry>>({});

  private detachers: Array<() => void> = [];
  private contextByIdentity = new Map<string, RepoContext>();
  private contextByRepoIdentity = new Map<string, RepoContext>();
  private defaultContextByPath = new Map<string, RepoContext>();
  private defaultContextByRepoPath = new Map<string, RepoContext>();
  private sessionIntents = new Map<string, SessionIntent>();
  private worktreeRequests = new Map<string, Promise<GitWorktree[]>>();
  private gitTaskPool = new GroupedTaskPool(2, 1);
  private worktreeListeners = new Set<(inventory: WorktreeInventory) => void>();
  private tickListeners = new Set<(
    cwd: string,
    changes: WorkingChangesResult,
    cause: GitRefreshCause,
    context: RepoContext
  ) => void>();
  private lastAppliedGenerationByCwd = new Map<string, number>();
  private observationKeysByRepoIdentity = new Map<string, Set<string>>();
  private paused = false;
  private refreshCoordinator = this.createRefreshCoordinator();
  private inventoryCoordinator = this.createInventoryCoordinator();

  statusFor(target: string | WorktreeScope, context?: RepoContext): GitStatus | null {
    const cwd = typeof target === 'string' ? target : target.cwd;
    const ctx = typeof target === 'string' ? context : target;
    return this.statuses[this.identityKey(cwd, ctx)]?.status ?? null;
  }

  loadingFor(cwd: string, context?: RepoContext): boolean {
    return this.statuses[this.identityKey(cwd, context)]?.loading ?? false;
  }

  errorFor(cwd: string, context?: RepoContext): string | null {
    return this.statuses[this.identityKey(cwd, context)]?.error ?? null;
  }

  contextFor(cwd: string, context?: RepoContext): RepoContext {
    const target = cwd.trim();
    const resolved = context ?? this.defaultContextByPath.get(target) ?? {};
    return this.contextByIdentity.get(worktreeIdentityKey(target, resolved)) ?? resolved;
  }

  shortstatFor(cwd: string, context?: RepoContext): GitShortstat | null {
    const ctx = this.resolveContext(cwd, context);
    const direct = this.shortstats[worktreeIdentityKey(cwd, ctx)]?.shortstat;
    if (direct) return direct;
    const repoPath = this.statuses[worktreeIdentityKey(cwd, ctx)]?.status?.repoPath ?? null;
    if (!repoPath) return null;
    return this.shortstats[worktreeIdentityKey(repoPath, ctx)]?.shortstat ?? null;
  }

  worktreesFor(repoPath: string, context?: RepoContext): GitWorktree[] | null {
    const target = repoPath.trim();
    if (!target) return null;
    return this.worktrees[this.repoIdentityKey(target, context)]?.worktrees ?? null;
  }

  worktreesLoadingFor(repoPath: string, context?: RepoContext): boolean {
    const target = repoPath.trim();
    if (!target) return false;
    return this.worktrees[this.repoIdentityKey(target, context)]?.loading ?? false;
  }

  worktreesErrorFor(repoPath: string, context?: RepoContext): string | null {
    const target = repoPath.trim();
    if (!target) return null;
    return this.worktrees[this.repoIdentityKey(target, context)]?.error ?? null;
  }

  setStatus(cwd: string, status: GitStatus, context?: RepoContext): void {
    const ctx = this.resolveContext(cwd, context);
    const cwdKey = worktreeIdentityKey(cwd, ctx);
    const entries: Record<string, GitStatusEntry> = {
      [cwdKey]: { status, loading: false, error: null }
    };
    if (status.repoPath) {
      entries[worktreeIdentityKey(status.repoPath, ctx)] = { status, loading: false, error: null };
    }
    this.statuses = { ...this.statuses, ...entries };
  }

  async loadStatus(cwd: string, force = false, context?: RepoContext): Promise<GitStatus | null> {
    const target = cwd.trim();
    if (!target) return null;
    const ctx = this.resolveContext(target, context);
    const key = worktreeIdentityKey(target, ctx);
    this.statuses = {
      ...this.statuses,
      [key]: {
        status: this.statuses[key]?.status ?? null,
        loading: true,
        error: null
      }
    };
    try {
      const status = await ipc.git.status({
        cwd: target,
        force,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {}),
        ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {})
      });
      this.rememberContext(target, ctx);
      if (status.repoPath) this.rememberRepoContext(status.repoPath, ctx);
      this.statuses = {
        ...this.statuses,
        [key]: { status, loading: false, error: null },
        ...(status.repoPath ? {
          [worktreeIdentityKey(status.repoPath, ctx)]: { status, loading: false, error: null }
        } : {})
      };
      return status;
    } catch (err) {
      this.statuses = {
        ...this.statuses,
        [key]: {
          status: this.statuses[key]?.status ?? null,
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        }
      };
      return null;
    }
  }

  async loadShortstat(
    repoPath: string,
    force = false,
    context?: RepoContext
  ): Promise<GitShortstat | null> {
    const target = repoPath.trim();
    if (!target) return null;
    const ctx = this.resolveRepoContext(target, context);
    const key = worktreeIdentityKey(target, ctx);
    this.shortstats = {
      ...this.shortstats,
      [key]: {
        shortstat: this.shortstats[key]?.shortstat ?? null,
        loading: true,
        error: null
      }
    };
    try {
      const shortstat = await ipc.git.shortstat({
        repoPath: target,
        force,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {}),
        ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {})
      });
      this.shortstats = {
        ...this.shortstats,
        [key]: { shortstat, loading: false, error: null }
      };
      return shortstat;
    } catch (err) {
      this.shortstats = {
        ...this.shortstats,
        [key]: {
          shortstat: this.shortstats[key]?.shortstat ?? null,
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        }
      };
      return null;
    }
  }

  async loadWorktrees(
    repoPath: string,
    force = false,
    context?: RepoContext
  ): Promise<GitWorktree[]> {
    const target = repoPath.trim();
    if (!target) return [];
    const ctx = this.resolveRepoContext(target, context);
    const key = worktreeIdentityKey(target, ctx);
    const existing = this.worktrees[key];
    if (!force && existing?.worktrees) return existing.worktrees;
    const currentRequest = this.worktreeRequests.get(key);
    if (currentRequest) return currentRequest;

    if (!existing?.worktrees) {
      this.worktrees = {
        ...this.worktrees,
        [key]: { worktrees: null, loading: true, error: null }
      };
    }

    const request = this.gitTaskPool.run(
      () => ipc.git.worktrees({
        repoPath: target,
        force,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {}),
        ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {})
      }),
      {
        // Cached/UI discovery is more urgent than the forced minute cadence.
        priority: force ? 0 : 5,
        ...resourceGroupOption(ctx)
      }
    );
    this.worktreeRequests.set(key, request);
    try {
      const worktrees = await request;
      if (!sameWorktreeInventory(existing?.worktrees, worktrees) || existing?.error) {
        this.worktrees = {
          ...this.worktrees,
          [key]: { worktrees, loading: false, error: null }
        };
      }
      this.rememberRepoContext(target, ctx);
      this.publishWorktreeInventory({ repoPath: target, worktrees, context: ctx });
      return worktrees;
    } catch (err) {
      this.worktrees = {
        ...this.worktrees,
        [key]: {
          worktrees: existing?.worktrees ?? null,
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        }
      };
      return [];
    } finally {
      if (this.worktreeRequests.get(key) === request) {
        this.worktreeRequests.delete(key);
      }
    }
  }

  onWorktrees(listener: (inventory: WorktreeInventory) => void): () => void {
    this.worktreeListeners.add(listener);
    return () => this.worktreeListeners.delete(listener);
  }

  private publishWorktreeInventory(inventory: WorktreeInventory): void {
    for (const listener of this.worktreeListeners) {
      try {
        listener(inventory);
      } catch {
        // Inventory publication cannot turn a successful Git read into failure.
      }
    }
  }

  private createRefreshCoordinator(): GitRefreshCoordinator<PollingContext, GitObservationResult> {
    const coordinator = new GitRefreshCoordinator<PollingContext, GitObservationResult>(
      async (_key, context, cause) => {
        const resolved = context ?? { cwd: '' };
        const { cwd, ...runtime } = resolved;
        return this.observeWorkingTree(cwd, runtime, cause);
      },
      {
        intervals: REFRESH_INTERVALS,
        maxConcurrency: 2,
        maxPerGroup: 1
      }
    );
    coordinator.subscribe((event) => this.applyObservation(event));
    if (this.paused) coordinator.setPollingPaused(true);
    return coordinator;
  }

  private createInventoryCoordinator(): GitRefreshCoordinator<InventoryContext, GitWorktree[]> {
    const coordinator = new GitRefreshCoordinator<InventoryContext, GitWorktree[]>(
      async (_key, context, cause) => {
        const resolved = context ?? { repoPath: '' };
        const { repoPath, ...runtime } = resolved;
        return this.loadWorktrees(repoPath, cause.kind !== 'initial', runtime);
      },
      {
        intervals: INVENTORY_INTERVALS,
        maxConcurrency: 2,
        maxPerGroup: 1
      }
    );
    if (this.paused) coordinator.setPollingPaused(true);
    return coordinator;
  }

  private async observeWorkingTree(
    cwd: string,
    ctx: RepoContext,
    cause: GitRefreshCause
  ): Promise<GitObservationResult> {
    try {
      const snapshot = await this.gitTaskPool.run(
        () => ipc.git.workingTreeSnapshot({
          cwd,
          force: true,
          ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
          ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {}),
          ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {})
        }),
        {
          priority: cause.kind === 'filesystem' || cause.kind === 'manual' ? 20 : 10,
          ...resourceGroupOption(ctx)
        }
      );
      return { cwd, context: ctx, snapshot, error: null };
    } catch (err) {
      return {
        cwd,
        context: ctx,
        snapshot: null,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private applyObservation(event: GitRefreshEvent<GitObservationResult>): void {
    const { key, cause, result } = event;
    const { cwd, context } = result;
    if (!result.snapshot) {
      this.statuses = {
        ...this.statuses,
        [key]: {
          status: this.statuses[key]?.status ?? null,
          loading: false,
          error: result.error
        }
      };
      return;
    }
    const snapshot = result.snapshot;
    const previousGeneration = this.lastAppliedGenerationByCwd.get(key) ?? -1;
    if (snapshot.generation <= previousGeneration) return;
    this.lastAppliedGenerationByCwd.set(key, snapshot.generation);
    const status = snapshot.status;
    this.rememberContext(cwd, context);
    this.setStatus(cwd, status, context);
    if (status.repoPath) {
      this.rememberRepoContext(status.repoPath, context);
      const repoKey = worktreeIdentityKey(status.repoPath, context);
      const observationKeys = this.observationKeysByRepoIdentity.get(repoKey) ?? new Set<string>();
      observationKeys.add(key);
      this.observationKeysByRepoIdentity.set(repoKey, observationKeys);
      this.shortstats = {
        ...this.shortstats,
        [worktreeIdentityKey(status.repoPath, context)]: {
          shortstat: snapshot.shortstat,
          loading: false,
          error: null
        }
      };
    }
    this.fireTick(cwd, snapshot.workingChanges, cause, context);
  }

  // Notify listeners that a Worktree Observation completed. The working-diff
  // store shares its cadence: 5s for foreground demand and 30s for a Worktree
  // that owns only background Sessions.
  private fireTick(
    cwd: string,
    changes: WorkingChangesResult,
    cause: GitRefreshCause,
    context: RepoContext
  ): void {
    for (const cb of this.tickListeners) {
      try {
        cb(cwd, changes, cause, context);
      } catch {
        // A consumer cannot turn a successful observation into a scheduler error.
      }
    }
  }

  onTick(cb: (
    cwd: string,
    changes: WorkingChangesResult,
    cause: GitRefreshCause,
    context: RepoContext
  ) => void): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  // Update session-driven polling intents. Foreground demand observes every
  // 5s; Worktrees that only own long-lived shells observe every 30s.
  // Caller passes the full list each call; missing entries are dropped.
  setWorktreePolling(intents: WorktreePollIntent[]): void {
    const previous = this.sessionIntents;
    const next = new Map<string, SessionIntent>();
    for (const intent of intents) {
      const cwd = intent.cwd.trim();
      if (!cwd) continue;
      const ctx: RepoContext = {};
      if (intent.runMode) ctx.runMode = intent.runMode;
      if (intent.wslDistro) ctx.wslDistro = intent.wslDistro;
      if (intent.deviceId) ctx.deviceId = intent.deviceId;
      const key = worktreeIdentityKey(cwd, ctx);
      const prev = next.get(key);
      next.set(key, {
        cwd,
        cadence: mostUrgentCadence(prev?.cadence, intent.cadence),
        ctx: prev?.ctx ?? ctx
      });
      this.rememberContext(cwd, ctx);
    }
    this.sessionIntents = next;
    const released = new Set<string>();
    for (const [key, intent] of previous) {
      if (next.has(key)) continue;
      released.add(key);
      this.publishObservationDemand(intent, false);
    }
    for (const [key, intent] of next) {
      if (!previous.has(key)) this.publishObservationDemand(intent, true);
    }
    this.releaseObservations(released);
    this.applyPolling();
  }

  // Reconcile Worktree Inventory without creating Refresh Intent. Inventory
  // answers which Worktrees exist; only Session demand owns recurring Working
  // Tree Snapshots. This keeps project-only and invalid paths out of the
  // two-child Git Process Budget.
  async refreshProjectWorktrees(intents: ProjectPollIntent[], force = false): Promise<void> {
    const desired = new Map<string, GitRefreshIntent<InventoryContext>>();
    for (const intent of intents) {
      const repoPath = intent.repoPath.trim();
      if (!repoPath) continue;
      const ctx: RepoContext = {};
      if (intent.runMode) ctx.runMode = intent.runMode;
      if (intent.wslDistro) ctx.wslDistro = intent.wslDistro;
      if (intent.deviceId) ctx.deviceId = intent.deviceId;
      const key = worktreeIdentityKey(repoPath, ctx);
      const current = desired.get(key);
      desired.set(key, {
        key,
        cadence: mostUrgentCadence(current?.cadence, intent.cadence),
        eager: !this.worktrees[key]?.worktrees,
        ...resourceGroupOption(ctx),
        context: { repoPath, ...ctx },
        contextId: key
      });
      this.rememberRepoContext(repoPath, ctx);
    }
    const reconciled = [...desired.values()];
    this.inventoryCoordinator.reconcile(reconciled);
    if (force) {
      for (const intent of reconciled) {
        this.inventoryCoordinator.request(intent.key, { kind: 'manual' });
      }
    }
  }

  // Pause/resume observation based on window visibility. Intent is retained;
  // foreground work and accumulated change evidence catch up on resume, while
  // background observation remains staggered.
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.refreshCoordinator.setPollingPaused(paused);
    this.inventoryCoordinator.setPollingPaused(paused);
  }

  private applyPolling(): void {
    const desired = this.sessionIntents;
    const desiredKeys = new Set(desired.keys());
    for (const [repoKey, observationKeys] of this.observationKeysByRepoIdentity) {
      for (const key of observationKeys) {
        if (!desiredKeys.has(key)) observationKeys.delete(key);
      }
      if (observationKeys.size === 0) this.observationKeysByRepoIdentity.delete(repoKey);
    }

    const intents: GitRefreshIntent<PollingContext>[] = Array.from(
      desired,
      ([key, info]) => {
        const { cwd, cadence, ctx } = info;
        this.rememberContext(cwd, ctx);
        return {
          key,
          cadence,
          eager: cadence === 'foreground' || !this.statuses[key]?.status,
          ...resourceGroupOption(ctx),
          context: { cwd, ...ctx },
          contextId: key
        };
      }
    );
    this.refreshCoordinator.reconcile(intents);
    this.refreshCoordinator.setPollingPaused(this.paused);
  }

  private releaseObservations(keys: ReadonlySet<string>): void {
    if (keys.size === 0) return;
    const nextStatuses = { ...this.statuses };
    const nextShortstats = { ...this.shortstats };
    for (const key of keys) {
      const status = nextStatuses[key]?.status;
      const context = this.contextByIdentity.get(key) ?? {};
      if (status?.repoPath) {
        delete nextShortstats[worktreeIdentityKey(status.repoPath, context)];
      }
      delete nextShortstats[key];
      delete nextStatuses[key];
      this.lastAppliedGenerationByCwd.delete(key);
    }
    for (const [repoKey, observationKeys] of this.observationKeysByRepoIdentity) {
      for (const key of keys) observationKeys.delete(key);
      if (observationKeys.size > 0) continue;
      this.observationKeysByRepoIdentity.delete(repoKey);
      delete nextShortstats[repoKey];
    }
    this.statuses = nextStatuses;
    this.shortstats = nextShortstats;
  }

  private publishObservationDemand(intent: SessionIntent, active: boolean): void {
    void ipc.git.setObservationDemand({
      cwd: intent.cwd,
      active,
      ...intent.ctx
    }).catch(() => {
      // Filesystem observation is an optimization. Cadenced snapshots remain
      // authoritative when a platform watcher cannot be acquired.
    });
  }

  private identityKey(cwd: string, context?: RepoContext): string {
    return worktreeIdentityKey(cwd, this.resolveContext(cwd, context));
  }

  private repoIdentityKey(repoPath: string, context?: RepoContext): string {
    return worktreeIdentityKey(repoPath, this.resolveRepoContext(repoPath, context));
  }

  private resolveContext(cwd: string, context?: RepoContext): RepoContext {
    const target = cwd.trim();
    return context ?? this.defaultContextByPath.get(target) ?? {};
  }

  private resolveRepoContext(repoPath: string, context?: RepoContext): RepoContext {
    const target = repoPath.trim();
    return context ?? this.defaultContextByRepoPath.get(target) ?? {};
  }

  private rememberContext(cwd: string, context: RepoContext): void {
    const target = cwd.trim();
    if (!target) return;
    const key = worktreeIdentityKey(target, context);
    this.contextByIdentity.set(key, { ...context });
    this.defaultContextByPath.set(target, { ...context });
  }

  private rememberRepoContext(repoPath: string, context: RepoContext): void {
    const target = repoPath.trim();
    if (!target) return;
    const key = worktreeIdentityKey(target, context);
    this.contextByRepoIdentity.set(key, { ...context });
    this.defaultContextByRepoPath.set(target, { ...context });
  }

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.git.onChange((event) => {
        const occurredAt = Date.now();
        const eventContext: RepoContext = {
          runMode: event.runMode,
          ...(event.wslDistro ? { wslDistro: event.wslDistro } : {}),
          ...('deviceId' in event && typeof event.deviceId === 'string'
            ? { deviceId: event.deviceId }
            : {})
        };
        const eventKey = worktreeIdentityKey(event.repoPath, eventContext);
        const identities = new Set<string>([
          eventKey,
          ...(this.observationKeysByRepoIdentity.get(eventKey) ?? [])
        ]);
        for (const key of identities) {
          this.refreshCoordinator.request(key, { kind: 'filesystem', occurredAt });
        }
      })
    );
    this.detachers.push(
      ipc.connection.onReconnect(() => {
        for (const [key, intent] of this.sessionIntents) {
          this.publishObservationDemand(intent, true);
          this.refreshCoordinator.request(key, { kind: 'manual' });
        }
      })
    );

    // Pause polling when the Electron window is hidden/minimized; resume
    // on visibility restore. applyPolling() ticks each worktree once on
    // resume so the UI catches up immediately.
    const onVisibility = () => this.setPaused(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    this.detachers.push(() => document.removeEventListener('visibilitychange', onVisibility));
    this.setPaused(document.visibilityState === 'hidden');

  }

  detach(): void {
    const released = new Set(this.sessionIntents.keys());
    for (const intent of this.sessionIntents.values()) {
      this.publishObservationDemand(intent, false);
    }
    this.sessionIntents = new Map();
    this.releaseObservations(released);
    for (const off of this.detachers) off();
    this.detachers = [];
    this.refreshCoordinator.dispose();
    this.refreshCoordinator = this.createRefreshCoordinator();
    this.inventoryCoordinator.dispose();
    this.inventoryCoordinator = this.createInventoryCoordinator();
  }
}

export const git = new GitStore();

function resourceGroupOption(ctx: RepoContext): { group?: string } {
  if (ctx.deviceId) return { group: `device:${ctx.deviceId}` };
  if (ctx.runMode !== 'wsl') return {};
  return { group: `wsl:${ctx.wslDistro?.trim() || 'default'}` };
}

const REFRESH_CADENCE_PRIORITY: Readonly<Record<GitRefreshCadence, number>> = {
  foreground: 2,
  background: 1
};

function mostUrgentCadence(
  current: GitRefreshCadence | undefined,
  candidate: GitRefreshCadence
): GitRefreshCadence {
  if (!current) return candidate;
  return REFRESH_CADENCE_PRIORITY[candidate] > REFRESH_CADENCE_PRIORITY[current]
    ? candidate
    : current;
}

function sameWorktreeInventory(
  previous: readonly GitWorktree[] | null | undefined,
  next: readonly GitWorktree[]
): boolean {
  if (!previous || previous.length !== next.length) return false;
  return previous.every((worktree, index) => {
    const candidate = next[index];
    return Boolean(
      candidate
      && worktree.path === candidate.path
      && worktree.branch === candidate.branch
      && worktree.head === candidate.head
      && worktree.detached === candidate.detached
      && worktree.bare === candidate.bare
      && worktree.isMain === candidate.isMain
    );
  });
}
