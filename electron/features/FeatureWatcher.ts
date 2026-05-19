import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RunMode } from '@shared/types/sessions.js';
import type { FeatureChangeEvent } from '@shared/types/features.js';

interface SubscriptionKey {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
}

interface WatcherState {
  key: SubscriptionKey;
  refCount: number;
  signature: string;
  timer: NodeJS.Timeout | null;
}

// Per-worktree refresh ticker. Avoids chokidar/fs.watch entirely so the
// behavior is identical across Windows-native worktrees and \\wsl.localhost
// shares (where fs.watch events don't reliably cross the boundary). Each tick
// hashes a "signature" of the artifact directory mtimes; when it changes we
// emit a coarse change event and the renderer refetches the snapshot.
export class FeatureWatcher {
  private subscriptions = new Map<string, WatcherState>();
  private listeners = new Set<(event: FeatureChangeEvent) => void>();
  private readonly intervalMs: number;

  constructor(opts: { intervalMs?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? 2500;
  }

  onChange(fn: (event: FeatureChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  subscribe(key: SubscriptionKey): () => void {
    if (!key.cwd?.trim()) return () => undefined;
    const id = this.subscriptionId(key);
    const existing = this.subscriptions.get(id);
    if (existing) {
      existing.refCount += 1;
      return () => this.release(id);
    }
    const state: WatcherState = {
      key,
      refCount: 1,
      signature: '',
      timer: null
    };
    this.subscriptions.set(id, state);
    // Prime the signature so the first real tick doesn't fire spuriously.
    void this.computeSignature(state).then((sig) => {
      state.signature = sig;
    });
    state.timer = setInterval(() => {
      void this.tick(state);
    }, this.intervalMs);
    state.timer.unref?.();
    return () => this.release(id);
  }

  dispose(): void {
    for (const state of this.subscriptions.values()) {
      if (state.timer) clearInterval(state.timer);
    }
    this.subscriptions.clear();
    this.listeners.clear();
  }

  private release(id: string): void {
    const state = this.subscriptions.get(id);
    if (!state) return;
    state.refCount -= 1;
    if (state.refCount <= 0) {
      if (state.timer) clearInterval(state.timer);
      this.subscriptions.delete(id);
    }
  }

  private subscriptionId(key: SubscriptionKey): string {
    return `${key.runMode}::${key.wslDistro ?? ''}::${key.cwd}`;
  }

  private async tick(state: WatcherState): Promise<void> {
    try {
      const next = await this.computeSignature(state);
      if (next === state.signature) return;
      state.signature = next;
      this.broadcast({ cwd: state.key.cwd, kind: 'features' });
    } catch {
      // Ignore transient errors — the next tick will retry.
    }
  }

  private broadcast(event: FeatureChangeEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // Listener errors are swallowed; one bad subscriber shouldn't kill watcher.
      }
    }
  }

  private async computeSignature(state: WatcherState): Promise<string> {
    const host = hostPathFor(state.key.cwd, state.key.runMode, state.key.wslDistro);
    const targets = [
      joinPath(host, 'CLAUDE.md'),
      joinPath(host, 'AGENTS.md'),
      joinPath(host, 'CONTEXT.md'),
      joinPath(host, 'docs', 'agents'),
      joinPath(host, 'docs', 'grill'),
      joinPath(host, 'docs', 'plans'),
      joinPath(host, '.scratch')
    ];
    const parts: string[] = [];
    for (const target of targets) {
      parts.push(await mtimeDigest(target));
    }
    return parts.join('|');
  }
}

async function mtimeDigest(targetPath: string): Promise<string> {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      // Include shallow children so adding/removing a feature slug counts as
      // a change. We don't recurse here — only the immediate child list is
      // signalful for our purposes; deeper changes are caught by their parent
      // directory's mtime bump on most filesystems.
      let children = '';
      try {
        const entries = await fs.readdir(targetPath);
        children = entries.sort().join(',');
      } catch {
        children = '';
      }
      // Stat each child to catch in-place edits of files like coverage-map.md
      // that don't change the parent directory's mtime.
      const childMtimes: string[] = [];
      try {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subDigest = await mtimeDigest(joinPath(targetPath, entry.name));
            childMtimes.push(`${entry.name}=${subDigest}`);
          } else if (entry.isFile()) {
            try {
              const childStat = await fs.stat(joinPath(targetPath, entry.name));
              childMtimes.push(`${entry.name}=${Math.round(childStat.mtimeMs)}`);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
      return `d:${Math.round(stat.mtimeMs)}:${children}:${childMtimes.join(';')}`;
    }
    return `f:${Math.round(stat.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

function hostPathFor(cwd: string, runMode: RunMode, wslDistro?: string): string {
  if (runMode === 'wsl' && process.platform === 'win32') {
    if (!wslDistro) return cwd;
    const parts = cwd.split('/').filter(Boolean);
    return ['\\\\wsl.localhost', wslDistro, ...parts].join('\\');
  }
  return cwd;
}

function joinPath(host: string, ...segments: string[]): string {
  if (host.startsWith('\\\\')) {
    return [host.replace(/\\$/u, ''), ...segments].join('\\');
  }
  return path.join(host, ...segments);
}
