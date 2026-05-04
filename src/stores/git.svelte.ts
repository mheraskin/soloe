import type { GitShortstat, GitStatus } from '@shared/types/git.js';
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

export interface WorktreePollIntent {
  cwd: string;
  fast: boolean;
  runMode?: RunMode;
  wslDistro?: string;
}

interface RepoContext {
  runMode?: RunMode;
  wslDistro?: string;
}

const FAST_INTERVAL_MS = 1500;
const SLOW_INTERVAL_MS = 15000;

interface PollEntry {
  cwd: string;
  fast: boolean;
  handle: ReturnType<typeof setInterval>;
}

class GitStore {
  statuses = $state<Record<string, GitStatusEntry>>({});
  shortstats = $state<Record<string, GitShortstatEntry>>({});

  private detachers: Array<() => void> = [];
  private pollers = new Map<string, PollEntry>();
  private contextByCwd = new Map<string, RepoContext>();
  private contextByRepoPath = new Map<string, RepoContext>();

  statusFor(cwd: string): GitStatus | null {
    return this.statuses[cwd]?.status ?? null;
  }

  loadingFor(cwd: string): boolean {
    return this.statuses[cwd]?.loading ?? false;
  }

  errorFor(cwd: string): string | null {
    return this.statuses[cwd]?.error ?? null;
  }

  shortstatFor(cwd: string): GitShortstat | null {
    const direct = this.shortstats[cwd]?.shortstat;
    if (direct) return direct;
    const repoPath = this.statuses[cwd]?.status?.repoPath ?? null;
    if (!repoPath) return null;
    return this.shortstats[repoPath]?.shortstat ?? null;
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

  // Polls status + shortstat for the given worktree once.
  private async tick(cwd: string): Promise<void> {
    const status = await this.loadStatus(cwd, true);
    if (status?.repoPath) await this.loadShortstat(status.repoPath, true);
  }

  // Update the set of worktrees being polled. `fast: true` polls every 1.5s
  // (worktrees with active terminals), `fast: false` polls every 15s (idle).
  // Cwds present in the previous call but missing from the new one stop being
  // polled; cwds that change tier reset their timer.
  setWorktreePolling(intents: WorktreePollIntent[]): void {
    const desired = new Map<string, boolean>();
    const seenCwds = new Set<string>();
    for (const intent of intents) {
      const cwd = intent.cwd.trim();
      if (!cwd) continue;
      // If the same cwd appears twice (e.g. as both fast and slow), the fast
      // wins — at least one session there is active.
      desired.set(cwd, desired.get(cwd) || intent.fast);
      seenCwds.add(cwd);
      if (intent.runMode || intent.wslDistro) {
        const ctx: RepoContext = {};
        if (intent.runMode) ctx.runMode = intent.runMode;
        if (intent.wslDistro) ctx.wslDistro = intent.wslDistro;
        this.contextByCwd.set(cwd, ctx);
      }
    }
    for (const cwd of this.contextByCwd.keys()) {
      if (!seenCwds.has(cwd)) this.contextByCwd.delete(cwd);
    }

    for (const [cwd, entry] of this.pollers) {
      const next = desired.get(cwd);
      if (next === undefined) {
        clearInterval(entry.handle);
        this.pollers.delete(cwd);
        continue;
      }
      if (next !== entry.fast) {
        clearInterval(entry.handle);
        this.pollers.delete(cwd);
      }
    }

    for (const [cwd, fast] of desired) {
      if (this.pollers.has(cwd)) continue;
      const interval = fast ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
      void this.tick(cwd);
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
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
    for (const entry of this.pollers.values()) clearInterval(entry.handle);
    this.pollers.clear();
  }
}

export const git = new GitStore();
