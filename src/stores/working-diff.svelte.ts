import type {
  FileDiff,
  WorkingChange,
  WorkingChangesResult
} from '@shared/types/git.js';
import type { RunMode } from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';

interface RepoContext {
  runMode?: RunMode;
  wslDistro?: string;
}

interface ChangesEntry {
  result: WorkingChangesResult | null;
  loading: boolean;
  error: string | null;
}

interface DiffEntry {
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  // Bumped on every fetch; used to discard stale responses if a newer
  // request was issued while the previous one was still in flight.
  generation: number;
}

interface ActiveSelection {
  cwd: string;
  filePath: string;
}

const DEFAULT_CONTEXT_LINES = 3;

class WorkingDiffStore {
  // Keyed by working-tree cwd (a session/worktree path), since selection
  // and diff caches are per-worktree, not per repoPath.
  changesByCwd = $state<Record<string, ChangesEntry>>({});

  // Diff entries are keyed by `${cwd}::${filePath}` so two worktrees of the
  // same repo don't trample each other.
  diffsByKey = $state<Record<string, DiffEntry>>({});

  // The path of the file currently being inspected, per-cwd. Persists across
  // refreshes so the user doesn't lose their place when files shuffle.
  selectedByCwd = $state<Record<string, string>>({});

  // The currently-mounted-in-the-UI selection. Drives auto-load of diffs
  // and follows the active worktree.
  active = $state<ActiveSelection | null>(null);

  contextLines = $state<number>(DEFAULT_CONTEXT_LINES);

  // 'unified' for narrow rail use; 'split' for side-by-side when wide enough.
  viewMode = $state<'unified' | 'split'>('unified');

  // 'all' | 'staged' | 'unstaged' | 'untracked' — coarse filter.
  filter = $state<'all' | 'staged' | 'unstaged' | 'untracked'>('all');

  query = $state<string>('');

  private contextByCwd = new Map<string, RepoContext>();
  private inflightChanges = new Map<string, Promise<WorkingChangesResult | null>>();
  // Per-key in-flight diff fetches — selection clicks and the eager prefetch
  // share a single request when they hit the same file, so neither blocks
  // the other.
  private inflightDiffs = new Map<string, Promise<FileDiff | null>>();
  private detachers: Array<() => void> = [];
  private generationCounter = 0;
  // Cap eager prefetch on huge changesets. Beyond this we fall back to the
  // lazy per-click load — the user is unlikely to click through 200+ files
  // in a single review session anyway.
  private static readonly PREFETCH_CAP = 200;
  // How many diff fetches we allow in flight at the same time during prefetch.
  // Higher numbers swamp WSL git startup; lower numbers leave the queue idle.
  private static readonly PREFETCH_CONCURRENCY = 4;

  setContext(cwd: string, context: RepoContext): void {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    this.contextByCwd.set(trimmed, context);
  }

  changesFor(cwd: string): ChangesEntry {
    return (
      this.changesByCwd[cwd] ?? {
        result: null,
        loading: false,
        error: null
      }
    );
  }

  filteredChangesFor(cwd: string): WorkingChange[] {
    const all = this.changesFor(cwd).result?.changes ?? [];
    const q = this.query.trim().toLowerCase();
    return all.filter((change) => {
      if (this.filter === 'staged' && !change.staged) return false;
      if (this.filter === 'unstaged' && (change.staged || change.kind === 'untracked')) return false;
      if (this.filter === 'untracked' && change.kind !== 'untracked') return false;
      if (q) {
        const hay = `${change.path} ${change.fromPath ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  selectedFilePath(cwd: string): string | null {
    return this.selectedByCwd[cwd] ?? null;
  }

  // Compose the diffs cache key. Exported via a helper so components can read
  // out specific entries without colliding with other worktrees.
  diffKey(cwd: string, filePath: string): string {
    return `${cwd}::${filePath}`;
  }

  diffEntryFor(cwd: string, filePath: string): DiffEntry {
    return (
      this.diffsByKey[this.diffKey(cwd, filePath)] ?? {
        diff: null,
        loading: false,
        error: null,
        generation: 0
      }
    );
  }

  setActive(active: ActiveSelection | null): void {
    this.active = active;
  }

  setSelected(cwd: string, filePath: string | null): void {
    if (filePath === null) {
      const next = { ...this.selectedByCwd };
      delete next[cwd];
      this.selectedByCwd = next;
      return;
    }
    this.selectedByCwd = { ...this.selectedByCwd, [cwd]: filePath };
  }

  // Fetch the working-tree changes for a worktree. Coalesces concurrent
  // callers so a flurry of repaints + git events don't spawn duplicate
  // git invocations.
  async loadChanges(cwd: string): Promise<WorkingChangesResult | null> {
    const trimmed = cwd.trim();
    if (!trimmed) return null;
    const inflight = this.inflightChanges.get(trimmed);
    if (inflight) return inflight;

    const ctx = this.contextByCwd.get(trimmed) ?? {};
    const previous = this.changesByCwd[trimmed];
    this.changesByCwd = {
      ...this.changesByCwd,
      [trimmed]: {
        result: previous?.result ?? null,
        loading: true,
        error: null
      }
    };

    const request = ipc.git
      .workingChanges({
        cwd: trimmed,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      })
      .then((result) => {
        this.changesByCwd = {
          ...this.changesByCwd,
          [trimmed]: { result, loading: false, error: null }
        };
        // If the currently-selected file disappeared, clear it so the diff
        // pane doesn't show stale content. Pick the first available change
        // as a fallback so the user can keep reviewing.
        const selected = this.selectedByCwd[trimmed];
        if (selected && !result.changes.some((c) => c.path === selected)) {
          const fallback = result.changes[0]?.path ?? null;
          this.setSelected(trimmed, fallback);
        }
        return result;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.changesByCwd = {
          ...this.changesByCwd,
          [trimmed]: {
            result: previous?.result ?? null,
            loading: false,
            error: message
          }
        };
        return null;
      })
      .finally(() => {
        if (this.inflightChanges.get(trimmed) === request) {
          this.inflightChanges.delete(trimmed);
        }
      });

    this.inflightChanges.set(trimmed, request);
    return request;
  }

  async loadDiff(cwd: string, filePath: string): Promise<FileDiff | null> {
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd || !filePath) return null;
    const key = this.diffKey(trimmedCwd, filePath);

    // If another caller is already fetching this exact file, ride along on
    // their promise. Selection clicks and the eager prefetch all funnel
    // through this so we never issue duplicate work.
    const inflight = this.inflightDiffs.get(key);
    if (inflight) return inflight;

    // Cache hit: the previous fetch is still valid (cleared on invalidate
    // or context-lines change). Return immediately so re-mounting the
    // component or re-entering the effect costs nothing.
    const cached = this.diffsByKey[key];
    if (cached?.diff && !cached.error) return cached.diff;

    const promise = this.fetchDiff(trimmedCwd, filePath, key);
    this.inflightDiffs.set(key, promise);
    void promise.finally(() => {
      if (this.inflightDiffs.get(key) === promise) {
        this.inflightDiffs.delete(key);
      }
    });
    return promise;
  }

  private async fetchDiff(
    trimmedCwd: string,
    filePath: string,
    key: string
  ): Promise<FileDiff | null> {
    const ctx = this.contextByCwd.get(trimmedCwd) ?? {};
    const generation = ++this.generationCounter;
    const previous = this.diffsByKey[key];
    this.diffsByKey = {
      ...this.diffsByKey,
      [key]: {
        diff: previous?.diff ?? null,
        loading: true,
        error: null,
        generation
      }
    };

    try {
      const change = this.changesFor(trimmedCwd).result?.changes.find(
        (c) => c.path === filePath
      );
      const fromPath = change?.fromPath ?? null;
      const diff = await ipc.git.fileDiff({
        cwd: trimmedCwd,
        path: filePath,
        fromPath,
        contextLines: this.contextLines,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
      const current = this.diffsByKey[key];
      if (current && current.generation !== generation) return diff;
      this.diffsByKey = {
        ...this.diffsByKey,
        [key]: { diff, loading: false, error: null, generation }
      };
      return diff;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = this.diffsByKey[key];
      if (current && current.generation !== generation) return null;
      this.diffsByKey = {
        ...this.diffsByKey,
        [key]: {
          diff: previous?.diff ?? null,
          loading: false,
          error: message,
          generation
        }
      };
      return null;
    }
  }

  // Eagerly fetch every file's diff so cross-file clicks are instant. Each
  // worker pulls from a shared queue and calls `loadDiff`, which dedupes
  // against the selection-driven fetch and any cache hits. Failures are
  // swallowed at the per-file level so one bad file can't stall the rest.
  async prefetchDiffs(cwd: string): Promise<void> {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    const changes = this.changesFor(trimmed).result?.changes;
    if (!changes?.length) return;

    const queue = changes.slice(0, WorkingDiffStore.PREFETCH_CAP).map((c) => c.path);
    // The active file is the one the user is staring at — fetch it first so
    // a re-prime triggered mid-review refreshes their view ahead of every-
    // thing else.
    const activePath = this.active?.cwd === trimmed ? this.active.filePath : null;
    if (activePath) {
      const idx = queue.indexOf(activePath);
      if (idx > 0) {
        queue.splice(idx, 1);
        queue.unshift(activePath);
      }
    }
    const concurrency = Math.min(WorkingDiffStore.PREFETCH_CONCURRENCY, queue.length);
    const next = async (): Promise<void> => {
      while (queue.length > 0) {
        const filePath = queue.shift();
        if (!filePath) return;
        try {
          await this.loadDiff(trimmed, filePath);
        } catch {
          // per-file failure is non-fatal; the entry stores the error
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => next()));
  }

  async stageFiles(cwd: string, paths: string[]): Promise<void> {
    const trimmed = cwd.trim();
    if (!trimmed || !paths.length) return;
    const ctx = this.contextByCwd.get(trimmed) ?? {};
    await ipc.git.stageFiles({
      cwd: trimmed,
      paths,
      ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
      ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
    });
  }

  async unstageFiles(cwd: string, paths: string[]): Promise<void> {
    const trimmed = cwd.trim();
    if (!trimmed || !paths.length) return;
    const ctx = this.contextByCwd.get(trimmed) ?? {};
    await ipc.git.unstageFiles({
      cwd: trimmed,
      paths,
      ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
      ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
    });
  }

  setContextLines(value: number): void {
    const clamped = Math.max(0, Math.min(50, Math.trunc(value)));
    if (clamped === this.contextLines) return;
    this.contextLines = clamped;
    // Bump every entry's generation alongside clearing it. Any in-flight
    // fetches issued under the previous context-lines value will see a
    // generation mismatch when they return and discard their result, so
    // stale-context payloads can't land in the cache.
    const newGen = ++this.generationCounter;
    const next = { ...this.diffsByKey };
    for (const key of Object.keys(next)) {
      const entry = next[key];
      if (entry) next[key] = { ...entry, diff: null, generation: newGen };
    }
    this.diffsByKey = next;
    this.inflightDiffs.clear();
  }

  invalidate(cwd: string): void {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    // Drop the cached changes entry; next read triggers a fresh fetch.
    if (this.changesByCwd[trimmed]) {
      const next = { ...this.changesByCwd };
      delete next[trimmed];
      this.changesByCwd = next;
    }
    // Drop only this worktree's diff entries. Other worktrees of the same
    // repo (e.g., other branches) keep their cached state.
    const prefix = `${trimmed}::`;
    const remaining: Record<string, DiffEntry> = {};
    for (const [key, entry] of Object.entries(this.diffsByKey)) {
      if (!key.startsWith(prefix)) remaining[key] = entry;
    }
    this.diffsByKey = remaining;
    // Drop in-flight fetches for this worktree so the next loadDiff issues
    // a fresh request rather than reusing one that's about to land in a
    // cleared slot.
    for (const key of Array.from(this.inflightDiffs.keys())) {
      if (key.startsWith(prefix)) this.inflightDiffs.delete(key);
    }
  }

  // Drop the cached diff bodies for a worktree without forgetting that the
  // entries existed. Use this when the underlying files may have changed —
  // e.g. a git change event — so the next click forces a fresh fetch and
  // we re-prime the cache with current content.
  private clearDiffCache(cwd: string): void {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    const prefix = `${trimmed}::`;
    const newGen = ++this.generationCounter;
    const next = { ...this.diffsByKey };
    let touched = false;
    for (const key of Object.keys(next)) {
      if (!key.startsWith(prefix)) continue;
      const entry = next[key];
      if (entry) {
        next[key] = { ...entry, diff: null, error: null, generation: newGen };
        touched = true;
      }
    }
    if (touched) this.diffsByKey = next;
    for (const key of Array.from(this.inflightDiffs.keys())) {
      if (key.startsWith(prefix)) this.inflightDiffs.delete(key);
    }
  }

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.git.onChange((event) => {
        // The git change event identifies the repo by repoPath, but our
        // store is keyed by worktree cwd. Match by repoPath stored on the
        // result so each affected worktree refreshes.
        for (const [cwd, entry] of Object.entries(this.changesByCwd)) {
          if (entry.result?.repoPath !== event.repoPath) continue;
          void this.loadChanges(cwd).then((result) => {
            if (!result) return;
            // The file list may now disagree with what we cached: file
            // bodies likely moved, files may have appeared or vanished.
            // Drop the bodies and re-prime so the next click is instant
            // and shows current content.
            this.clearDiffCache(cwd);
            void this.prefetchDiffs(cwd);
          });
        }
      })
    );
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }
}

export const workingDiff = new WorkingDiffStore();
