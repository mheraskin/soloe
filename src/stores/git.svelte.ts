import type { GitStatus } from '@shared/types/git.js';
import { ipc } from '../lib/ipc';

interface GitStatusEntry {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
}

class GitStore {
  statuses = $state<Record<string, GitStatusEntry>>({});

  private detachers: Array<() => void> = [];

  statusFor(cwd: string): GitStatus | null {
    return this.statuses[cwd]?.status ?? null;
  }

  loadingFor(cwd: string): boolean {
    return this.statuses[cwd]?.loading ?? false;
  }

  errorFor(cwd: string): string | null {
    return this.statuses[cwd]?.error ?? null;
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

  async loadStatus(cwd: string, force = false): Promise<GitStatus | null> {
    const target = cwd.trim();
    if (!target) return null;
    this.statuses = {
      ...this.statuses,
      [target]: {
        status: this.statuses[target]?.status ?? null,
        loading: true,
        error: null
      }
    };
    try {
      const status = await ipc.git.status({ cwd: target, force });
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
      })
    );
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }
}

export const git = new GitStore();
