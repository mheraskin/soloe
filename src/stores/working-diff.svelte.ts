import type {
  BlameLine,
  FileDiff,
  GitCommit,
  RangeChange,
  WorkingChange,
  WorkingChangesResult
} from '@shared/types/git.js';
import type { RunMode } from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';
import { git } from './git.svelte';

export type ReviewMode =
  | { kind: 'working-tree' }
  | {
      kind: 'range';
      base: string;          // canonical 40-char SHA (parent of earliest commit)
      head: string;          // canonical 40-char SHA (newest commit)
      commits: GitCommit[];  // oldest-first, topologically ordered
      includeWorkingTree: boolean;
      chipFilter: string | null; // 40-char SHA when filtering by one commit
    };

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

interface FileLinesEntry {
  lines: string[] | null;
  totalLines: number;
  loading: boolean;
  error: string | null;
}

interface BlameEntry {
  // Sparse per-line attribution, indexed by new-side line number (1-based).
  // Slot 0 is unused so callers can read by lineNo directly without a -1.
  byLine: (BlameLine | undefined)[];
  loading: boolean;
  error: string | null;
}

const DEFAULT_CONTEXT_LINES = 3;

const WT_MARKER = 'WT';

class WorkingDiffStore {
  // Keyed by working-tree cwd (a session/worktree path), since selection
  // and diff caches are per-worktree, not per repoPath.
  changesByCwd = $state<Record<string, ChangesEntry>>({});

  // Diff entries are keyed by `${cwd}::${filePath}::${base}::${head}` so the
  // working-tree diff and the range diff for the same file don't collide.
  // base/head are the literal 'WT' string for working-tree-mode entries.
  diffsByKey = $state<Record<string, DiffEntry>>({});

  // Per-cwd review mode. Absence ⇒ working-tree mode (the default).
  reviewModeByCwd = $state<Record<string, ReviewMode>>({});

  // The path of the file currently being inspected, per-cwd. Persists across
  // refreshes so the user doesn't lose their place when files shuffle.
  selectedByCwd = $state<Record<string, string>>({});

  // The currently-mounted-in-the-UI selection. Drives auto-load of diffs
  // and follows the active worktree.
  active = $state<ActiveSelection | null>(null);

  contextLines = $state<number>(DEFAULT_CONTEXT_LINES);

  // 'unified' for narrow rail use; 'split' for side-by-side when wide enough.
  viewMode = $state<'unified' | 'split'>('unified');

  wordWrap = $state<boolean>(true);

  // 'all' | 'staged' | 'unstaged' | 'untracked' in working-tree mode; the
  // RailDiffTab swaps in the {all,wt,committed} triplet when in range mode.
  filter = $state<'all' | 'staged' | 'unstaged' | 'untracked' | 'wt' | 'committed'>('all');

  query = $state<string>('');

  pendingStage = $state<Record<string, true>>({});

  // Lazy-expanded gap content keyed by `${cwd}::${path}::${start}-${end}`.
  // Only filled when the user clicks an expander between hunks. Surviving
  // entries are dropped on file invalidation alongside the diff cache.
  fileLinesByKey = $state<Record<string, FileLinesEntry>>({});

  // Blame attribution keyed by `${cwd}::${path}::${head}`. Loaded lazily when
  // a file becomes visible in range mode; survives until the cwd invalidates
  // or the file's head moves.
  blamesByKey = $state<Record<string, BlameEntry>>({});

  private contextByCwd = new Map<string, RepoContext>();
  private inflightChanges = new Map<string, Promise<WorkingChangesResult | null>>();
  // Per-key in-flight diff fetches — selection clicks and the eager prefetch
  // share a single request when they hit the same file, so neither blocks
  // the other.
  private inflightDiffs = new Map<string, Promise<FileDiff | null>>();
  private inflightFileLines = new Map<string, Promise<FileLinesEntry>>();
  private inflightBlames = new Map<string, Promise<BlameEntry>>();
  private detachers: Array<() => void> = [];
  private generationCounter = 0;
  // `git diff HEAD` ignores the index, so stage/unstage events don't need a
  // diff-cache wipe — entries here mark the window during which we treat
  // change events as our own and skip the heavy refresh.
  private stageSuppressUntil = new Map<string, number>();
  private static readonly STAGE_SUPPRESS_MS = 1500;
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
    const mode = this.reviewModeByCwd[cwd];
    const chipFilter = mode?.kind === 'range' ? mode.chipFilter : null;
    return all.filter((change) => {
      if (this.filter === 'staged' && !change.staged) return false;
      if (this.filter === 'unstaged' && (change.staged || change.kind === 'untracked')) return false;
      if (this.filter === 'untracked' && change.kind !== 'untracked') return false;
      if (this.filter === 'wt' && change.section !== 'wt') return false;
      if (this.filter === 'committed' && change.section !== 'committed') return false;
      if (chipFilter && change.section === 'committed') {
        if (!change.commitsTouching?.includes(chipFilter)) return false;
      }
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

  reviewModeFor(cwd: string): ReviewMode {
    return this.reviewModeByCwd[cwd] ?? { kind: 'working-tree' };
  }

  setReviewMode(cwd: string, mode: ReviewMode): void {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    const prev = this.reviewModeByCwd[trimmed] ?? { kind: 'working-tree' };
    // Identity-by-content guard: a no-op set (re-applying the same mode)
    // shouldn't blow caches or refresh.
    if (sameReviewMode(prev, mode)) return;
    if (mode.kind === 'working-tree') {
      const next = { ...this.reviewModeByCwd };
      delete next[trimmed];
      this.reviewModeByCwd = next;
    } else {
      this.reviewModeByCwd = { ...this.reviewModeByCwd, [trimmed]: mode };
    }
    // The set of files in view + the per-file diff payload both change when
    // mode flips. Drop both caches scoped to this cwd so the next read fetches
    // fresh content under the new mode's keys.
    this.invalidate(trimmed);
    // Reset filter to 'all' on mode change — 'staged'/'unstaged' don't make
    // sense in range mode, and 'wt'/'committed' don't in working-tree mode.
    this.filter = 'all';
  }

  clearReviewMode(cwd: string): void {
    this.setReviewMode(cwd, { kind: 'working-tree' });
  }

  setChipFilter(cwd: string, sha: string | null): void {
    const mode = this.reviewModeByCwd[cwd];
    if (!mode || mode.kind !== 'range') return;
    if (mode.chipFilter === sha) return;
    this.reviewModeByCwd = {
      ...this.reviewModeByCwd,
      [cwd]: { ...mode, chipFilter: sha }
    };
  }

  setIncludeWorkingTree(cwd: string, include: boolean): void {
    const mode = this.reviewModeByCwd[cwd];
    if (!mode || mode.kind !== 'range') return;
    if (mode.includeWorkingTree === include) return;
    this.reviewModeByCwd = {
      ...this.reviewModeByCwd,
      [cwd]: { ...mode, includeWorkingTree: include }
    };
  }

  // Compose the diffs cache key. Mode-aware so working-tree-vs-HEAD and a
  // base..head range diff for the same file can co-exist in the cache.
  diffKey(cwd: string, filePath: string, base?: string | null, head?: string | null): string {
    return `${cwd}::${filePath}::${base ?? WT_MARKER}::${head ?? WT_MARKER}`;
  }

  // Pick the appropriate base/head for the given file under the current mode.
  // WT-only mode and the WT section of a range mode both render the same
  // working-tree diff (and share the same cache key).
  diffKeyForFile(cwd: string, change: WorkingChange): string {
    if (change.section === 'committed') {
      const mode = this.reviewModeByCwd[cwd];
      if (mode && mode.kind === 'range') {
        return this.diffKey(cwd, change.path, mode.base, mode.head);
      }
    }
    return this.diffKey(cwd, change.path);
  }

  diffEntryFor(cwd: string, filePath: string, base?: string | null, head?: string | null): DiffEntry {
    let resolvedBase = base ?? null;
    let resolvedHead = head ?? null;
    // When base/head aren't explicitly supplied, infer the right (base, head)
    // from the change's section so committed-section files in range mode hit
    // their range cache slot rather than the empty WT slot.
    if (resolvedBase === null && resolvedHead === null) {
      const change = this.changesFor(cwd).result?.changes.find((c) => c.path === filePath);
      const mode = this.reviewModeByCwd[cwd];
      if (change?.section === 'committed' && mode?.kind === 'range') {
        resolvedBase = mode.base;
        resolvedHead = mode.head;
      }
    }
    return (
      this.diffsByKey[this.diffKey(cwd, filePath, resolvedBase, resolvedHead)] ?? {
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
  // git invocations. In range mode, also fetches the committed file list
  // for the active base..head and merges both lists into a single result;
  // each entry carries `section` ('wt' | 'committed') so the UI can split
  // them under separate headers.
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

    const mode = this.reviewModeByCwd[trimmed];
    const fetchWt = !mode || mode.kind !== 'range' || mode.includeWorkingTree;
    const fetchRange = mode?.kind === 'range';

    const wtPromise = fetchWt
      ? ipc.git.workingChanges({
          cwd: trimmed,
          ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
          ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
        })
      : Promise.resolve<WorkingChangesResult>({
          repoPath: previous?.result?.repoPath ?? null,
          isRepo: previous?.result?.isRepo ?? true,
          changes: []
        });
    const rangePromise = fetchRange && mode?.kind === 'range'
      ? ipc.git.rangeChanges({
          cwd: trimmed,
          base: mode.base,
          head: mode.head,
          ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
          ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
        })
      : null;

    const request = Promise.all([wtPromise, rangePromise])
      .then(([wt, range]): WorkingChangesResult => {
        const merged: WorkingChange[] = wt.changes.map((c) => ({ ...c, section: 'wt' as const }));
        if (range) {
          for (const r of range.changes) {
            merged.push(rangeChangeToWorking(r));
          }
        }
        const result: WorkingChangesResult = {
          repoPath: wt.repoPath ?? previous?.result?.repoPath ?? null,
          isRepo: wt.isRepo || (previous?.result?.isRepo ?? false),
          changes: merged
        };
        this.changesByCwd = {
          ...this.changesByCwd,
          [trimmed]: { result, loading: false, error: null }
        };
        // If the currently-selected file disappeared, clear it so the diff
        // pane doesn't show stale content. Pick the first available change
        // as a fallback so the user can keep reviewing.
        const selected = this.selectedByCwd[trimmed];
        if (selected && !merged.some((c) => c.path === selected)) {
          const fallback = merged[0]?.path ?? null;
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
    // Selection lives at (cwd, path) granularity; the section discriminator
    // determines which base/head pair to fetch. Resolve the section from the
    // changes list, then key everything by the full quadruple.
    const change = this.changesFor(trimmedCwd).result?.changes.find(
      (c) => c.path === filePath
    );
    const mode = this.reviewModeByCwd[trimmedCwd];
    const isCommitted = change?.section === 'committed';
    const base = isCommitted && mode?.kind === 'range' ? mode.base : null;
    const head = isCommitted && mode?.kind === 'range' ? mode.head : null;
    const key = this.diffKey(trimmedCwd, filePath, base, head);

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

    const promise = this.fetchDiff(trimmedCwd, filePath, key, change, base, head);
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
    key: string,
    change: WorkingChange | undefined,
    base: string | null,
    head: string | null
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
      const fromPath = change?.fromPath ?? null;
      const diff = await ipc.git.fileDiff({
        cwd: trimmedCwd,
        path: filePath,
        fromPath,
        contextLines: this.contextLines,
        ...(base ? { base } : {}),
        ...(head ? { head } : {}),
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

  fileLinesKey(cwd: string, filePath: string, startLine: number, endLine: number): string {
    // The trailing head-marker keeps WT-mode gaps and range-mode gaps in
    // separate cache slots. Range mode reads the same on-disk content today
    // but the key shape is forward-compatible with a `--at <head>` fetch.
    const mode = this.reviewModeByCwd[cwd];
    const headMarker = mode?.kind === 'range' ? mode.head : WT_MARKER;
    return `${cwd}::${filePath}::${startLine}-${endLine}::${headMarker}`;
  }

  fileLinesEntry(
    cwd: string,
    filePath: string,
    startLine: number,
    endLine: number
  ): FileLinesEntry {
    const key = this.fileLinesKey(cwd, filePath, startLine, endLine);
    return (
      this.fileLinesByKey[key] ?? {
        lines: null,
        totalLines: 0,
        loading: false,
        error: null
      }
    );
  }

  async loadFileLines(
    cwd: string,
    filePath: string,
    startLine: number,
    endLine: number
  ): Promise<FileLinesEntry> {
    const trimmed = cwd.trim();
    const idle: FileLinesEntry = { lines: null, totalLines: 0, loading: false, error: null };
    if (!trimmed || !filePath || startLine > endLine) return idle;
    const key = this.fileLinesKey(trimmed, filePath, startLine, endLine);
    const existing = this.fileLinesByKey[key];
    if (existing?.lines) return existing;
    const inflight = this.inflightFileLines.get(key);
    if (inflight) return inflight;

    const ctx = this.contextByCwd.get(trimmed) ?? {};
    this.fileLinesByKey = {
      ...this.fileLinesByKey,
      [key]: { lines: null, totalLines: 0, loading: true, error: null }
    };

    const request = ipc.git
      .fileLines({
        cwd: trimmed,
        path: filePath,
        startLine,
        endLine,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      })
      .then((result): FileLinesEntry => {
        const entry: FileLinesEntry = {
          lines: result.lines,
          totalLines: result.totalLines,
          loading: false,
          error: null
        };
        this.fileLinesByKey = { ...this.fileLinesByKey, [key]: entry };
        return entry;
      })
      .catch((err: unknown): FileLinesEntry => {
        const message = err instanceof Error ? err.message : String(err);
        const entry: FileLinesEntry = {
          lines: null,
          totalLines: 0,
          loading: false,
          error: message
        };
        this.fileLinesByKey = { ...this.fileLinesByKey, [key]: entry };
        return entry;
      })
      .finally(() => {
        if (this.inflightFileLines.get(key) === request) {
          this.inflightFileLines.delete(key);
        }
      });

    this.inflightFileLines.set(key, request);
    return request;
  }

  blameKey(cwd: string, filePath: string, head: string): string {
    return `${cwd}::${filePath}::${head}`;
  }

  blameEntry(cwd: string, filePath: string, head: string): BlameEntry {
    return (
      this.blamesByKey[this.blameKey(cwd, filePath, head)] ?? {
        byLine: [],
        loading: false,
        error: null
      }
    );
  }

  async loadBlame(cwd: string, filePath: string, head: string): Promise<BlameEntry> {
    const trimmed = cwd.trim();
    const idle: BlameEntry = { byLine: [], loading: false, error: null };
    if (!trimmed || !filePath || !head) return idle;
    const key = this.blameKey(trimmed, filePath, head);
    const existing = this.blamesByKey[key];
    if (existing && !existing.error && existing.byLine.length > 0) return existing;
    const inflight = this.inflightBlames.get(key);
    if (inflight) return inflight;

    const ctx = this.contextByCwd.get(trimmed) ?? {};
    this.blamesByKey = {
      ...this.blamesByKey,
      [key]: { byLine: existing?.byLine ?? [], loading: true, error: null }
    };

    const request = ipc.git
      .fileBlame({
        cwd: trimmed,
        path: filePath,
        head,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      })
      .then((result): BlameEntry => {
        const byLine: (BlameLine | undefined)[] = [];
        for (const line of result.lines) {
          byLine[line.lineNo] = line;
        }
        const entry: BlameEntry = { byLine, loading: false, error: null };
        this.blamesByKey = { ...this.blamesByKey, [key]: entry };
        return entry;
      })
      .catch((err: unknown): BlameEntry => {
        const message = err instanceof Error ? err.message : String(err);
        const entry: BlameEntry = {
          byLine: existing?.byLine ?? [],
          loading: false,
          error: message
        };
        this.blamesByKey = { ...this.blamesByKey, [key]: entry };
        return entry;
      })
      .finally(() => {
        if (this.inflightBlames.get(key) === request) {
          this.inflightBlames.delete(key);
        }
      });

    this.inflightBlames.set(key, request);
    return request;
  }

  // Resolve the new-side SHAs attributed to a [startLine..endLine] range on
  // `side`. For 'new', look up blame directly. For 'old', map each oldLine to
  // its newLine via the cached diff; lines that don't exist on the new side
  // are skipped (the line is gone, so there's no blame target). The result is
  // intersected with the active reviewMode's selected commits so chips never
  // surface SHAs the user didn't pick.
  attributedCommitsFor(
    cwd: string,
    filePath: string,
    head: string,
    side: 'old' | 'new',
    startLine: number,
    endLine: number
  ): string[] {
    const mode = this.reviewModeByCwd[cwd];
    if (!mode || mode.kind !== 'range') return [];
    const selected = new Set(mode.commits.map((c) => c.hash));
    const blame = this.blameEntry(cwd, filePath, head).byLine;
    if (blame.length === 0) return [];

    const newLines: number[] = [];
    if (side === 'new') {
      for (let n = startLine; n <= endLine; n += 1) newLines.push(n);
    } else {
      // Map old-side lines through the diff. Only context rows carry both
      // sides, so we mostly recover pairs there; remove-only lines have no
      // new-side counterpart and are intentionally dropped.
      const diff = this.diffEntryFor(cwd, filePath, mode.base, mode.head).diff;
      if (!diff) return [];
      for (const hunk of diff.hunks) {
        for (const line of hunk.lines) {
          if (line.oldLine === null || line.newLine === null) continue;
          if (line.oldLine < startLine || line.oldLine > endLine) continue;
          newLines.push(line.newLine);
        }
      }
    }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of newLines) {
      const entry = blame[n];
      if (!entry) continue;
      if (!selected.has(entry.sha)) continue;
      if (seen.has(entry.sha)) continue;
      seen.add(entry.sha);
      out.push(entry.sha);
    }
    return out;
  }

  async stageFiles(cwd: string, paths: string[]): Promise<void> {
    const trimmed = cwd.trim();
    if (!trimmed || !paths.length) return;
    const previous = this.applyStagedLocally(trimmed, paths, true);
    this.markPending(trimmed, paths, true);
    this.stageSuppressUntil.set(
      trimmed,
      Date.now() + WorkingDiffStore.STAGE_SUPPRESS_MS
    );
    const ctx = this.contextByCwd.get(trimmed) ?? {};
    try {
      await ipc.git.stageFiles({
        cwd: trimmed,
        paths,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
    } catch (err) {
      if (previous) this.restoreStagedLocally(trimmed, previous);
      throw err;
    } finally {
      this.markPending(trimmed, paths, false);
    }
  }

  async unstageFiles(cwd: string, paths: string[]): Promise<void> {
    const trimmed = cwd.trim();
    if (!trimmed || !paths.length) return;
    const previous = this.applyStagedLocally(trimmed, paths, false);
    this.markPending(trimmed, paths, true);
    this.stageSuppressUntil.set(
      trimmed,
      Date.now() + WorkingDiffStore.STAGE_SUPPRESS_MS
    );
    const ctx = this.contextByCwd.get(trimmed) ?? {};
    try {
      await ipc.git.unstageFiles({
        cwd: trimmed,
        paths,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
    } catch (err) {
      if (previous) this.restoreStagedLocally(trimmed, previous);
      throw err;
    } finally {
      this.markPending(trimmed, paths, false);
    }
  }

  async discardFiles(cwd: string, files: WorkingChange[]): Promise<void> {
    const trimmed = cwd.trim();
    if (!trimmed || !files.length) return;
    const paths = files.map((f) => f.path);
    this.markPending(trimmed, paths, true);
    const ctx = this.contextByCwd.get(trimmed) ?? {};
    try {
      await ipc.git.discardFiles({
        cwd: trimmed,
        files: files.map((f) => ({
          path: f.path,
          kind: f.kind,
          ...(f.fromPath ? { fromPath: f.fromPath } : {})
        })),
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
    } finally {
      this.markPending(trimmed, paths, false);
    }
  }

  isStagePending(cwd: string, path: string): boolean {
    return this.pendingStage[`${cwd}::${path}`] === true;
  }

  private markPending(cwd: string, paths: string[], pending: boolean): void {
    if (!paths.length) return;
    const next = { ...this.pendingStage };
    let touched = false;
    for (const p of paths) {
      const key = `${cwd}::${p}`;
      if (pending) {
        if (next[key] !== true) {
          next[key] = true;
          touched = true;
        }
      } else if (key in next) {
        delete next[key];
        touched = true;
      }
    }
    if (touched) this.pendingStage = next;
  }

  private applyStagedLocally(
    cwd: string,
    paths: string[],
    staged: boolean
  ): Map<string, boolean> | null {
    const entry = this.changesByCwd[cwd];
    if (!entry?.result) return null;
    const pathSet = new Set(paths);
    const previous = new Map<string, boolean>();
    let touched = false;
    const newChanges = entry.result.changes.map((c) => {
      if (!pathSet.has(c.path)) return c;
      if (c.staged === staged) return c;
      previous.set(c.path, c.staged);
      touched = true;
      return { ...c, staged };
    });
    if (!touched) return null;
    this.changesByCwd = {
      ...this.changesByCwd,
      [cwd]: {
        ...entry,
        result: { ...entry.result, changes: newChanges }
      }
    };
    return previous;
  }

  private restoreStagedLocally(cwd: string, previous: Map<string, boolean>): void {
    const entry = this.changesByCwd[cwd];
    if (!entry?.result) return;
    const newChanges = entry.result.changes.map((c) =>
      previous.has(c.path) ? { ...c, staged: previous.get(c.path) ?? c.staged } : c
    );
    this.changesByCwd = {
      ...this.changesByCwd,
      [cwd]: {
        ...entry,
        result: { ...entry.result, changes: newChanges }
      }
    };
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
    // Hunk boundaries shift when ctx changes, so existing gap expansions
    // become meaningless. Drop them all and let users re-expand on demand.
    this.fileLinesByKey = {};
    this.inflightFileLines.clear();
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
    this.dropFileLines(prefix);
    this.dropBlames(prefix);
  }

  private dropBlames(prefix: string): void {
    const remaining: Record<string, BlameEntry> = {};
    let touched = false;
    for (const [key, entry] of Object.entries(this.blamesByKey)) {
      if (key.startsWith(prefix)) {
        touched = true;
        continue;
      }
      remaining[key] = entry;
    }
    if (touched) this.blamesByKey = remaining;
    for (const key of Array.from(this.inflightBlames.keys())) {
      if (key.startsWith(prefix)) this.inflightBlames.delete(key);
    }
  }

  private dropFileLines(prefix: string): void {
    const remaining: Record<string, FileLinesEntry> = {};
    let touched = false;
    for (const [key, entry] of Object.entries(this.fileLinesByKey)) {
      if (key.startsWith(prefix)) {
        touched = true;
        continue;
      }
      remaining[key] = entry;
    }
    if (touched) this.fileLinesByKey = remaining;
    for (const key of Array.from(this.inflightFileLines.keys())) {
      if (key.startsWith(prefix)) this.inflightFileLines.delete(key);
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
    this.dropFileLines(prefix);
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
          if ((this.stageSuppressUntil.get(cwd) ?? 0) > Date.now()) continue;
          this.refreshCwd(cwd, true);
        }
      })
    );
    // Polling fallback: ride the git store's tick so the diff pane refreshes
    // on the same 5s/30s cadence as tab line counts. Without this, the diff
    // pane only updates on filesystem-driven onChange events and can lag
    // behind the tab badges when changes originate outside the watcher.
    this.detachers.push(
      git.onTick((cwd) => {
        if (!this.changesByCwd[cwd]) return;
        if ((this.stageSuppressUntil.get(cwd) ?? 0) > Date.now()) return;
        this.refreshCwd(cwd, false);
      })
    );
  }

  // `forceDiffRefresh` clears the per-file diff cache regardless of whether
  // the changes list looks identical; used by filesystem-watcher events that
  // already indicate something changed. The polling-tick path passes false
  // and compares signatures so unchanged worktrees don't refetch all diffs
  // every 5s.
  private refreshCwd(cwd: string, forceDiffRefresh: boolean): void {
    const before = this.changesSignature(this.changesByCwd[cwd]?.result ?? null);
    void this.loadChanges(cwd).then((result) => {
      if (!result) return;
      const after = this.changesSignature(result);
      if (forceDiffRefresh || before !== after) {
        this.clearDiffCache(cwd);
        void this.prefetchDiffs(cwd);
      }
    });
  }

  private changesSignature(result: WorkingChangesResult | null): string {
    if (!result) return '';
    return result.changes
      .map(
        (c) =>
          `${c.path}|${c.fromPath ?? ''}|${c.kind}|${c.staged ? 1 : 0}|${c.insertions}|${c.deletions}|${c.binary ? 1 : 0}`
      )
      .join('\n');
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }
}

function sameReviewMode(a: ReviewMode, b: ReviewMode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'working-tree') return true;
  if (b.kind !== 'range') return false;
  if (a.base !== b.base || a.head !== b.head) return false;
  if (a.includeWorkingTree !== b.includeWorkingTree) return false;
  if (a.chipFilter !== b.chipFilter) return false;
  if (a.commits.length !== b.commits.length) return false;
  for (let i = 0; i < a.commits.length; i += 1) {
    if (a.commits[i]?.hash !== b.commits[i]?.hash) return false;
  }
  return true;
}

function rangeChangeToWorking(r: RangeChange): WorkingChange {
  return {
    path: r.path,
    fromPath: r.fromPath,
    kind: r.kind,
    staged: false,
    insertions: r.insertions,
    deletions: r.deletions,
    binary: r.binary,
    section: 'committed',
    commitsTouching: r.commitsTouching
  };
}

export const workingDiff = new WorkingDiffStore();
