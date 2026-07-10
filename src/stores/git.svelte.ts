import type { GitShortstat, GitStatus, GitWorktree } from '@shared/types/git.js';
import type { RunMode } from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';

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
  fast: boolean;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface ProjectPollIntent {
  repoPath: string;
  runMode?: RunMode;
  wslDistro?: string;
}

interface RepoContext {
  runMode?: RunMode;
  wslDistro?: string;
}

const FAST_INTERVAL_MS = 5000;
const SLOW_INTERVAL_MS = 30000;
// External `git worktree add/remove` (run in a terminal or the OS) doesn't fire
// any in-app git event, and the backend's fs.watch is unreliable (off on WSL).
// So force a relist of every known project's worktrees on this cadence to keep
// the sidebar in sync. Paused with the window. Every relist forces one
// `git worktree list` per project past the main-process cache — a `wsl.exe`
// spawn each under WSL — so this cadence has to stay coarse.
const WORKTREE_REFRESH_INTERVAL_MS = 60_000;

interface PollEntry {
  cwd: string;
  fast: boolean;
  handle: ReturnType<typeof setInterval>;
}

interface SessionIntent {
  fast: boolean;
  ctx: RepoContext;
}

class GitStore {
  statuses = $state<Record<string, GitStatusEntry>>({});
  shortstats = $state<Record<string, GitShortstatEntry>>({});
  worktrees = $state<Record<string, GitWorktreesEntry>>({});

  private detachers: Array<() => void> = [];
  private pollers = new Map<string, PollEntry>();
  private contextByCwd = new Map<string, RepoContext>();
  private contextByRepoPath = new Map<string, RepoContext>();
  private sessionIntents = new Map<string, SessionIntent>();
  private projectIntents = new Map<string, RepoContext>();
  private projectIntentSeq = 0;
  private worktreeRequests = new Map<string, Promise<GitWorktree[]>>();
  private tickListeners = new Set<(cwd: string) => void>();
  private paused = false;
  private lastProjectIntents: ProjectPollIntent[] = [];
  private worktreeRefreshHandle: ReturnType<typeof setInterval> | null = null;

  statusFor(cwd: string): GitStatus | null {
    return this.statuses[cwd]?.status ?? null;
  }

  loadingFor(cwd: string): boolean {
    return this.statuses[cwd]?.loading ?? false;
  }

  errorFor(cwd: string): string | null {
    return this.statuses[cwd]?.error ?? null;
  }

  contextFor(cwd: string): RepoContext {
    return this.contextByCwd.get(cwd.trim()) ?? {};
  }

  shortstatFor(cwd: string): GitShortstat | null {
    const direct = this.shortstats[cwd]?.shortstat;
    if (direct) return direct;
    const repoPath = this.statuses[cwd]?.status?.repoPath ?? null;
    if (!repoPath) return null;
    return this.shortstats[repoPath]?.shortstat ?? null;
  }

  worktreesFor(repoPath: string): GitWorktree[] | null {
    const target = repoPath.trim();
    if (!target) return null;
    return this.worktrees[target]?.worktrees ?? null;
  }

  worktreesLoadingFor(repoPath: string): boolean {
    const target = repoPath.trim();
    if (!target) return false;
    return this.worktrees[target]?.loading ?? false;
  }

  worktreesErrorFor(repoPath: string): string | null {
    const target = repoPath.trim();
    if (!target) return null;
    return this.worktrees[target]?.error ?? null;
  }

  setStatus(cwd: string, status: GitStatus): void {
    const entries: Record<string, GitStatusEntry> = {
      [cwd]: { status, loading: false, error: null }
    };
    if (status.repoPath) {
      entries[status.repoPath] = { status, loading: false, error: null };
    }
    this.statuses = { ...this.statuses, ...entries };
  }

  async loadStatus(cwd: string, force = false, context?: RepoContext): Promise<GitStatus | null> {
    const target = cwd.trim();
    if (!target) return null;
    const ctx = context ?? this.contextByCwd.get(target) ?? {};
    this.statuses = {
      ...this.statuses,
      [target]: {
        status: this.statuses[target]?.status ?? null,
        loading: true,
        error: null
      }
    };
    try {
      const status = await ipc.git.status({
        cwd: target,
        force,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
      if (status.repoPath) this.contextByRepoPath.set(status.repoPath, ctx);
      this.statuses = {
        ...this.statuses,
        [target]: { status, loading: false, error: null },
        ...(status.repoPath ? { [status.repoPath]: { status, loading: false, error: null } } : {})
      };
      return status;
    } catch (err) {
      this.statuses = {
        ...this.statuses,
        [target]: {
          status: this.statuses[target]?.status ?? null,
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
    const ctx = context ?? this.contextByRepoPath.get(target) ?? {};
    this.shortstats = {
      ...this.shortstats,
      [target]: {
        shortstat: this.shortstats[target]?.shortstat ?? null,
        loading: true,
        error: null
      }
    };
    try {
      const shortstat = await ipc.git.shortstat({
        repoPath: target,
        force,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
      this.shortstats = {
        ...this.shortstats,
        [target]: { shortstat, loading: false, error: null }
      };
      return shortstat;
    } catch (err) {
      this.shortstats = {
        ...this.shortstats,
        [target]: {
          shortstat: this.shortstats[target]?.shortstat ?? null,
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
    const existing = this.worktrees[target];
    if (!force && existing?.worktrees) return existing.worktrees;
    const currentRequest = this.worktreeRequests.get(target);
    if (currentRequest) return currentRequest;

    const ctx = context ?? this.contextByRepoPath.get(target) ?? {};
    this.worktrees = {
      ...this.worktrees,
      [target]: {
        worktrees: existing?.worktrees ?? null,
        loading: true,
        error: null
      }
    };

    const request = ipc.git.worktrees({
      repoPath: target,
      force,
      ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
      ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
    });
    this.worktreeRequests.set(target, request);
    try {
      const worktrees = await request;
      this.worktrees = {
        ...this.worktrees,
        [target]: { worktrees, loading: false, error: null }
      };
      return worktrees;
    } catch (err) {
      this.worktrees = {
        ...this.worktrees,
        [target]: {
          worktrees: existing?.worktrees ?? null,
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        }
      };
      return [];
    } finally {
      if (this.worktreeRequests.get(target) === request) {
        this.worktreeRequests.delete(target);
      }
    }
  }

  // Polls status + shortstat for the given worktree once.
  private async tick(cwd: string): Promise<void> {
    const status = await this.loadStatus(cwd, true);
    if (!status?.repoPath) {
      this.fireTick(cwd);
      return;
    }
    // When the worktree is fully clean, shortstat is provably 0/0/0;
    // synthesize it locally and skip the extra git invocation. Otherwise
    // (any staged, unstaged, or untracked entry) fetch the real numbers
    // since untracked files now contribute insertions too.
    if (!status.dirty) {
      this.shortstats = {
        ...this.shortstats,
        [status.repoPath]: {
          shortstat: {
            repoPath: status.repoPath,
            isRepo: true,
            filesChanged: 0,
            insertions: 0,
            deletions: 0
          },
          loading: false,
          error: null
        }
      };
      this.fireTick(cwd);
      return;
    }
    await this.loadShortstat(status.repoPath, true);
    this.fireTick(cwd);
  }

  // Notify listeners that a polling tick completed for this cwd. Used by
  // the working-diff store so its refresh cadence matches the tab line-count
  // cadence (5s when a session in the worktree is active, 30s when idle).
  private fireTick(cwd: string): void {
    for (const cb of this.tickListeners) cb(cwd);
  }

  onTick(cb: (cwd: string) => void): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  // Update session-driven polling intents. `fast: true` polls every 5s
  // (worktrees with active terminals), `fast: false` polls every 30s (idle).
  // Caller passes the full list each call; missing entries are dropped.
  setWorktreePolling(intents: WorktreePollIntent[]): void {
    this.sessionIntents.clear();
    for (const intent of intents) {
      const cwd = intent.cwd.trim();
      if (!cwd) continue;
      const ctx: RepoContext = {};
      if (intent.runMode) ctx.runMode = intent.runMode;
      if (intent.wslDistro) ctx.wslDistro = intent.wslDistro;
      const prev = this.sessionIntents.get(cwd);
      this.sessionIntents.set(cwd, {
        fast: (prev?.fast ?? false) || intent.fast,
        // Keep the first context seen for a cwd; sessions in the same worktree
        // should agree on runMode/wslDistro.
        ctx: prev?.ctx ?? ctx
      });
    }
    this.applyPolling();
  }

  // Register every worktree of every known project for slow-tier polling so
  // sessionless worktrees still display +N −N. Fetches `git worktree list`
  // for each project; failures fall back to just the project root path.
  async refreshProjectWorktrees(intents: ProjectPollIntent[], force = false): Promise<void> {
    this.lastProjectIntents = intents;
    const seq = ++this.projectIntentSeq;
    const next = new Map<string, RepoContext>();
    await Promise.all(
      intents.map(async (intent) => {
        const repoPath = intent.repoPath.trim();
        if (!repoPath) return;
        const ctx: RepoContext = {};
        if (intent.runMode) ctx.runMode = intent.runMode;
        if (intent.wslDistro) ctx.wslDistro = intent.wslDistro;
        const worktrees = await this.loadWorktrees(repoPath, force, ctx);
        if (worktrees.length === 0) {
          next.set(repoPath, ctx);
          return;
        }
        for (const wt of worktrees) {
          if (wt.path) next.set(wt.path, ctx);
        }
      })
    );
    if (seq !== this.projectIntentSeq) return;
    this.projectIntents = next;
    this.applyPolling();
  }

  // Pause/resume polling based on window visibility. While paused, all
  // intervals are torn down; intents are still tracked so resume can
  // recreate them and tick each worktree once to catch up.
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.applyPolling();
  }

  private applyPolling(): void {
    // Merge: project worktrees seed slow-tier intents and supply context;
    // session intents may bump tier to fast and override context.
    const desired = new Map<string, boolean>();
    const ctxByCwd = new Map<string, RepoContext>();
    for (const [cwd, ctx] of this.projectIntents) {
      desired.set(cwd, false);
      ctxByCwd.set(cwd, ctx);
    }
    for (const [cwd, info] of this.sessionIntents) {
      desired.set(cwd, (desired.get(cwd) ?? false) || info.fast);
      if (info.ctx.runMode || info.ctx.wslDistro) ctxByCwd.set(cwd, info.ctx);
    }
    this.contextByCwd = ctxByCwd;

    // While paused (window hidden/minimized), tear down everything and
    // create nothing. On resume the second loop re-creates each poller.
    const effective = this.paused ? new Map<string, boolean>() : desired;

    // A worktree whose only change is its tier still holds a fresh status, so
    // the recreated poller must not re-tick. Without this, selecting a session
    // costs two forced `git status` runs — one for the worktree entering the
    // fast tier and one for the worktree leaving it.
    const retiered = new Set<string>();

    for (const [cwd, entry] of this.pollers) {
      const next = effective.get(cwd);
      if (next === undefined) {
        clearInterval(entry.handle);
        this.pollers.delete(cwd);
        continue;
      }
      if (next !== entry.fast) {
        clearInterval(entry.handle);
        this.pollers.delete(cwd);
        retiered.add(cwd);
      }
    }

    for (const [cwd, fast] of effective) {
      if (this.pollers.has(cwd)) continue;
      const interval = fast ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
      // Tick immediately only when the UI would otherwise show nothing (a
      // worktree we've never polled) or when the user is looking at it. Idle
      // worktrees that already have a status ride their interval, so resuming
      // from a pause doesn't spawn one `git status` per known worktree at once.
      const needsBadge = !this.statuses[cwd]?.status;
      if (!retiered.has(cwd) && (fast || needsBadge)) void this.tick(cwd);
      const handle = setInterval(() => void this.tick(cwd), interval);
      this.pollers.set(cwd, { cwd, fast, handle });
    }
  }

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.git.onChange((event) => {
        const paths = new Set<string>();
        for (const [cwd, entry] of Object.entries(this.statuses)) {
          if (cwd === event.repoPath || entry.status?.repoPath === event.repoPath) {
            paths.add(cwd);
          }
        }
        for (const cwd of paths) {
          void this.loadStatus(cwd, true);
        }
        void this.loadShortstat(event.repoPath, true);
      })
    );

    // Pause polling when the Electron window is hidden/minimized; resume
    // on visibility restore. applyPolling() ticks each worktree once on
    // resume so the UI catches up immediately.
    const onVisibility = () => this.setPaused(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    this.detachers.push(() => document.removeEventListener('visibilitychange', onVisibility));
    this.setPaused(document.visibilityState === 'hidden');

    // Force a periodic worktree relist so external add/remove shows up without a
    // manual refresh. No-op until the first refreshProjectWorktrees seeds the
    // intents; skipped while the window is hidden.
    this.worktreeRefreshHandle = setInterval(() => {
      if (this.paused || this.lastProjectIntents.length === 0) return;
      void this.refreshProjectWorktrees(this.lastProjectIntents, true);
    }, WORKTREE_REFRESH_INTERVAL_MS);
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
    for (const entry of this.pollers.values()) clearInterval(entry.handle);
    this.pollers.clear();
    if (this.worktreeRefreshHandle) {
      clearInterval(this.worktreeRefreshHandle);
      this.worktreeRefreshHandle = null;
    }
  }
}

export const git = new GitStore();
