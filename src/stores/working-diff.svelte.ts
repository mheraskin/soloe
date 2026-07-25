import type {
  BlameLine,
  FileDiff,
  GitCommit,
  RangeChange,
  WorkingChange,
  WorkingChangesResult
} from '@shared/types/git.js';
import type { RunMode } from '@shared/types/sessions.js';
import { untrack } from 'svelte';
import {
  worktreeIdentityKey,
  worktreeScope,
  type WorktreeScope
} from '@shared/worktree-identity.js';
import { ipc } from '../lib/ipc';
import type { GitRefreshCause } from '../lib/git-refresh-coordinator';
import {
  estimateBlameBytes,
  estimateFileDiffBytes,
  ReviewPayloadCache,
  type ReviewPayloadEviction,
  type ReviewPayloadStats
} from '../lib/review-payload-cache';
import {
  findReviewEntry,
  isReviewEntryId,
  reviewEntryId,
  reviewEntryIdFrom,
  reviewEntryPath,
  reviewEntrySection,
  type ReviewEntryId,
  type ReviewEntrySection
} from '../lib/review-entry';
import {
  shouldAutoLoadUntrackedDiff,
  UNTRACKED_DIFF_AUTOLOAD_CONCURRENCY
} from '../lib/untracked-diff-autoload';
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

/** Immutable runtime-qualified scope for one review surface or action. */
export type ReviewScope = WorktreeScope;

export function createReviewScope(cwd: string, context: RepoContext = {}): ReviewScope {
  return worktreeScope(cwd, context);
}

type ReviewTarget = string | ReviewScope;

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
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const DEFAULT_CONTEXT_LINES = 3;

const WT_MARKER = 'WT';

export class WorkingDiffStore {
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
  selectedByCwd = $state<Record<string, ReviewEntryId>>({});

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

  private currentIdentityByCwd = $state<Record<string, string>>({});
  private contextByIdentity = new Map<string, RepoContext>();
  // Keyed by immutable review identity, not cwd alone. A working-tree request
  // already in flight must never satisfy a newly-selected commit range.
  private inflightChanges = new Map<string, Promise<WorkingChangesResult | null>>();
  private changesEpochByCwd = new Map<string, number>();
  // Per-key in-flight diff fetches — selection clicks and viewport prefetch
  // share a single request when they hit the same file, so neither blocks
  // the other.
  private inflightDiffs = new Map<string, Promise<FileDiff | null>>();
  private inflightFileLines = new Map<string, Promise<FileLinesEntry>>();
  private inflightBlames = new Map<string, Promise<BlameEntry>>();
  private reviewDemandByIdentity = new Map<string, number>();
  private detachers: Array<() => void> = [];
  private generationCounter = 0;
  private contextEpoch = 0;
  private prefetchEpochByCwd = new Map<string, number>();
  private reviewPayloadCache = new ReviewPayloadCache();
  private untrackedDiffAutoloadPool = new AsyncTaskPool(
    UNTRACKED_DIFF_AUTOLOAD_CONCURRENCY
  );
  // `git diff HEAD` ignores the index, so stage/unstage events don't need a
  // diff-cache wipe — entries here mark the window during which we treat
  // change events as our own and skip the heavy refresh.
  private stageSuppressUntil = new Map<string, number>();
  private static readonly STAGE_SUPPRESS_MS = 1500;
  // A review-wide Git patch is process-efficient, but materializing hundreds
  // of FileDiff payloads still creates a large IPC and heap spike. The review
  // viewport requests its resident window through this bounded batch.
  private static readonly PREFETCH_CAP = 16;

  setContext(cwd: string, context: RepoContext): void {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    const identity = worktreeIdentityKey(trimmed, context);
    this.contextByIdentity.set(identity, { ...context });
    if (this.currentIdentityByCwd[trimmed] === identity) return;
    this.currentIdentityByCwd = { ...this.currentIdentityByCwd, [trimmed]: identity };
  }

  changesFor(target: ReviewTarget): ChangesEntry {
    const identity = this.identityFor(target);
    return (
      this.changesByCwd[identity] ?? {
        result: null,
        loading: false,
        error: null
      }
    );
  }

  filteredChangesFor(target: ReviewTarget): WorkingChange[] {
    const identity = this.identityFor(target);
    const all = this.changesFor(target).result?.changes ?? [];
    const q = this.query.trim().toLowerCase();
    const mode = this.reviewModeByCwd[identity];
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

  selectedFilePath(target: ReviewTarget): string | null {
    const selected = this.selectedByCwd[this.identityFor(target)];
    return selected ? reviewEntryPath(selected) : null;
  }

  selectedReviewEntry(target: ReviewTarget): ReviewEntryId | null {
    return this.selectedByCwd[this.identityFor(target)] ?? null;
  }

  reviewModeFor(target: ReviewTarget): ReviewMode {
    return this.reviewModeByCwd[this.identityFor(target)] ?? { kind: 'working-tree' };
  }

  setReviewMode(target: ReviewTarget, mode: ReviewMode): void {
    const { cwd: trimmed, identity } = this.resolveTarget(target);
    if (!trimmed) return;
    const prev = this.reviewModeByCwd[identity] ?? { kind: 'working-tree' };
    // Identity-by-content guard: a no-op set (re-applying the same mode)
    // shouldn't blow caches or refresh.
    if (sameReviewMode(prev, mode)) return;
    if (mode.kind === 'working-tree') {
      const next = { ...this.reviewModeByCwd };
      delete next[identity];
      this.reviewModeByCwd = next;
    } else {
      this.reviewModeByCwd = { ...this.reviewModeByCwd, [identity]: mode };
    }
    // The set of files in view + the per-file diff payload both change when
    // mode flips. Drop both caches scoped to this cwd so the next read fetches
    // fresh content under the new mode's keys.
    this.invalidate(target);
    // Reset filter to 'all' on mode change — 'staged'/'unstaged' don't make
    // sense in range mode, and 'wt'/'committed' don't in working-tree mode.
    this.filter = 'all';
  }

  clearReviewMode(target: ReviewTarget): void {
    this.setReviewMode(target, { kind: 'working-tree' });
  }

  setChipFilter(target: ReviewTarget, sha: string | null): void {
    const identity = this.identityFor(target);
    const mode = this.reviewModeByCwd[identity];
    if (!mode || mode.kind !== 'range') return;
    if (mode.chipFilter === sha) return;
    this.reviewModeByCwd = {
      ...this.reviewModeByCwd,
      [identity]: { ...mode, chipFilter: sha }
    };
  }

  setIncludeWorkingTree(target: ReviewTarget, include: boolean): void {
    const identity = this.identityFor(target);
    const mode = this.reviewModeByCwd[identity];
    if (!mode || mode.kind !== 'range') return;
    if (mode.includeWorkingTree === include) return;
    this.reviewModeByCwd = {
      ...this.reviewModeByCwd,
      [identity]: { ...mode, includeWorkingTree: include }
    };
  }

  // Compose the diffs cache key. Mode-aware so working-tree-vs-HEAD and a
  // base..head range diff for the same file can co-exist in the cache.
  diffKey(target: ReviewTarget, filePath: string, base?: string | null, head?: string | null): string {
    return this.diffKeyForIdentity(this.identityFor(target), filePath, base, head);
  }

  // Pick the appropriate base/head for the given file under the current mode.
  // WT-only mode and the WT section of a range mode both render the same
  // working-tree diff (and share the same cache key).
  diffKeyForFile(target: ReviewTarget, change: WorkingChange): string {
    if (change.section === 'committed') {
      const mode = this.reviewModeByCwd[this.identityFor(target)];
      if (mode && mode.kind === 'range') {
        return this.diffKey(target, change.path, mode.base, mode.head);
      }
    }
    return this.diffKey(target, change.path);
  }

  diffEntryFor(target: ReviewTarget, filePath: string, base?: string | null, head?: string | null): DiffEntry {
    let resolvedBase = base ?? null;
    let resolvedHead = head ?? null;
    // When base/head aren't explicitly supplied, infer the right (base, head)
    // from the change's section so committed-section files in range mode hit
    // their range cache slot rather than the empty WT slot.
    if (resolvedBase === null && resolvedHead === null) {
      const change = this.changesFor(target).result?.changes.find((c) => c.path === filePath);
      const mode = this.reviewModeByCwd[this.identityFor(target)];
      if (change?.section === 'committed' && mode?.kind === 'range') {
        resolvedBase = mode.base;
        resolvedHead = mode.head;
      }
    }
    return (
      this.diffsByKey[this.diffKey(target, filePath, resolvedBase, resolvedHead)] ?? {
        diff: null,
        loading: false,
        error: null,
        generation: 0
      }
    );
  }

  setReviewResidents(target: ReviewTarget | null, filePaths: Iterable<string>): void {
    this.applyReviewPayloadEvictions(
      this.reviewPayloadCache.setResidents(target ? this.identityFor(target) : null, filePaths)
    );
  }

  reviewPayloadStats(): ReviewPayloadStats {
    return this.reviewPayloadCache.stats();
  }

  /**
   * Acquires visible Review Surface demand for one Worktree Identity.
   * The first owner refreshes once; the final release stops Git-tick refresh,
   * rejects late materialization, and releases payload residency.
   */
  acquireReviewDemand(scope: ReviewScope): () => void {
    // Review Surfaces acquire this resource from Svelte effects. Context
    // registration and the first load synchronously read and update reactive
    // cache state, but those internals are not dependencies of the Surface's
    // lifetime. Tracking them creates an acquire → load → teardown → release
    // cycle whenever the loading entry changes.
    return untrack(() => {
      const { identity } = this.resolveTarget(scope);
      this.setContext(scope.cwd, scope);
      const previous = this.reviewDemandByIdentity.get(identity) ?? 0;
      this.reviewDemandByIdentity.set(identity, previous + 1);
      if (previous === 0) void this.loadChanges(scope);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        untrack(() => {
          const current = this.reviewDemandByIdentity.get(identity) ?? 0;
          if (current > 1) {
            this.reviewDemandByIdentity.set(identity, current - 1);
            return;
          }
          this.reviewDemandByIdentity.delete(identity);
          this.suspendReviewDemand(identity);
          if (this.reviewDemandByIdentity.size === 0) this.setReviewResidents(null, []);
        });
      };
    });
  }

  setSelected(
    target: ReviewTarget,
    filePath: string | null,
    section?: ReviewEntrySection
  ): void {
    const identity = this.identityFor(target);
    if (filePath === null) {
      const next = { ...this.selectedByCwd };
      delete next[identity];
      this.selectedByCwd = next;
      return;
    }
    const mode = this.reviewModeFor(target);
    const current = this.selectedByCwd[identity];
    if (
      current &&
      reviewEntryPath(current) === filePath &&
      (!section || current === reviewEntryIdFrom(filePath, section, mode))
    ) return;
    const changes = this.changesFor(target).result?.changes ?? [];
    const match = section
      ? changes.find(
          (change) => change.path === filePath && reviewEntrySection(change) === section
        )
      : changes.find((change) => change.path === filePath);
    const entryId = match
      ? reviewEntryId(match, mode)
      : reviewEntryIdFrom(filePath, section ?? 'wt', mode);
    this.selectedByCwd = { ...this.selectedByCwd, [identity]: entryId };
  }

  setSelectedEntry(target: ReviewTarget, change: WorkingChange | null): void {
    if (!change) {
      this.setSelected(target, null);
      return;
    }
    const identity = this.identityFor(target);
    this.selectedByCwd = {
      ...this.selectedByCwd,
      [identity]: reviewEntryId(change, this.reviewModeFor(target))
    };
  }

  // Fetch the working-tree changes for a worktree. Coalesces concurrent
  // callers so a flurry of repaints + git events don't spawn duplicate
  // git invocations. In range mode, also fetches the committed file list
  // for the active base..head and merges both lists into a single result;
  // each entry carries `section` ('wt' | 'committed') so the UI can split
  // them under separate headers.
  async loadChanges(
    target: ReviewTarget,
    observedWorkingTree?: WorkingChangesResult
  ): Promise<WorkingChangesResult | null> {
    const { cwd: trimmed, identity, context: ctx } = this.resolveTarget(target);
    if (!trimmed) return null;
    const mode = this.reviewModeByCwd[identity];
    const requestKey = changesRequestKey(identity, mode, ctx);
    const inflight = this.inflightChanges.get(requestKey);
    if (inflight) return inflight;

    const epoch = this.changesEpochByCwd.get(identity) ?? 0;
    const previous = this.changesByCwd[identity];
    this.changesByCwd = {
      ...this.changesByCwd,
      [identity]: {
        result: previous?.result ?? null,
        loading: true,
        error: null
      }
    };

    const fetchWt = !mode || mode.kind !== 'range' || mode.includeWorkingTree;
    const fetchRange = mode?.kind === 'range';

    const wtPromise = fetchWt
      ? observedWorkingTree
        ? Promise.resolve(observedWorkingTree)
        : ipc.git.workingChanges({
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
        if ((this.changesEpochByCwd.get(identity) ?? 0) !== epoch) return result;
        this.changesByCwd = {
          ...this.changesByCwd,
          [identity]: { result, loading: false, error: null }
        };
        // If the currently-selected file disappeared, clear it so the diff
        // pane doesn't show stale content. Pick the first available change
        // as a fallback so the user can keep reviewing.
        const selected = this.selectedByCwd[identity];
        if (selected && !findReviewEntry(merged, selected, mode)) {
          const next = { ...this.selectedByCwd };
          if (merged[0]) next[identity] = reviewEntryId(merged[0], mode ?? { kind: 'working-tree' });
          else delete next[identity];
          this.selectedByCwd = next;
        }
        return result;
      })
      .catch((err: unknown) => {
        if ((this.changesEpochByCwd.get(identity) ?? 0) !== epoch) return null;
        const message = err instanceof Error ? err.message : String(err);
        this.changesByCwd = {
          ...this.changesByCwd,
          [identity]: {
            result: previous?.result ?? null,
            loading: false,
            error: message
          }
        };
        return null;
      })
      .finally(() => {
        if (this.inflightChanges.get(requestKey) === request) {
          this.inflightChanges.delete(requestKey);
        }
      });

    this.inflightChanges.set(requestKey, request);
    return request;
  }

  async loadDiff(
    target: ReviewTarget,
    filePath: string,
    section?: ReviewEntrySection
  ): Promise<FileDiff | null> {
    const { cwd: trimmedCwd, identity } = this.resolveTarget(target);
    if (!trimmedCwd || !filePath) return null;
    // Selection lives at (cwd, path) granularity; the section discriminator
    // determines which base/head pair to fetch. Resolve the section from the
    // changes list, then key everything by the full quadruple.
    const changes = this.changesFor(target).result?.changes ?? [];
    const selected = this.selectedByCwd[identity];
    const mode = this.reviewModeFor(target);
    const change = section
      ? changes.find(
          (candidate) =>
            candidate.path === filePath && reviewEntrySection(candidate) === section
        )
      : selected && reviewEntryPath(selected) === filePath
        ? findReviewEntry(changes, selected, mode)
        : changes.find((candidate) => candidate.path === filePath);
    const isCommitted = change?.section === 'committed';
    const base = isCommitted && mode.kind === 'range' ? mode.base : null;
    const head = isCommitted && mode.kind === 'range' ? mode.head : null;
    const key = this.diffKey(target, filePath, base, head);

    // If another caller is already fetching this exact file, ride along on
    // their promise. Selection clicks and the eager prefetch all funnel
    // through this so we never issue duplicate work.
    const inflight = this.inflightDiffs.get(key);
    if (inflight) return inflight;

    // Cache hit: the previous fetch is still valid (cleared on invalidate
    // or context-lines change). Return immediately so re-mounting the
    // component or re-entering the effect costs nothing.
    const cached = this.diffsByKey[key];
    if (cached?.diff && !cached.error) {
      this.reviewPayloadCache.touch('diff', key);
      return cached.diff;
    }

    const pinKey = change
      ? reviewEntryId(change, mode)
      : reviewEntryIdFrom(filePath, base && head ? 'committed' : 'wt', mode);
    const promise = this.fetchDiff(
      trimmedCwd,
      identity,
      filePath,
      key,
      change,
      base,
      head,
      pinKey
    );
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
    identity: string,
    filePath: string,
    key: string,
    change: WorkingChange | undefined,
    base: string | null,
    head: string | null,
    pinKey: ReviewEntryId
  ): Promise<FileDiff | null> {
    const ctx = this.contextByIdentity.get(identity) ?? {};
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
        ...(change?.kind === 'untracked' ? { untracked: true } : {}),
        ...(base ? { base } : {}),
        ...(head ? { head } : {}),
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
      const current = this.diffsByKey[key];
      if (current?.generation !== generation) return diff;
      this.diffsByKey = {
        ...this.diffsByKey,
        [key]: { diff, loading: false, error: null, generation }
      };
      this.applyReviewPayloadEvictions(
        this.reviewPayloadCache.remember({
          kind: 'diff',
          key,
          cwd: identity,
          pinKey,
          bytes: estimateFileDiffBytes(diff)
        })
      );
      return diff;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const current = this.diffsByKey[key];
      if (current?.generation !== generation) return null;
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

  // Materialize tracked diffs at review granularity. Working-tree and commit-
  // range files need distinct Git ranges, but each group costs one Git process
  // instead of one process (plus WSL repository discovery) per file. Safe
  // untracked files use the individual `--no-index` path through a shared
  // concurrency pool; generated, binary, and oversized entries stay lazy.
  async prefetchDiffs(target: ReviewTarget, entryIds?: Iterable<string>): Promise<void> {
    const { cwd: trimmed, identity, context: ctx } = this.resolveTarget(target);
    if (!trimmed) return;
    const changes = this.changesFor(target).result?.changes;
    if (!changes?.length) return;
    const mode = this.reviewModeFor(target);
    const contextLines = this.contextLines;
    const contextEpoch = this.contextEpoch;
    const epoch = this.prefetchEpochByCwd.get(identity) ?? 0;
    const requested = entryIds ? Array.from(new Set(entryIds)) : null;
    const selectedEntry = this.selectedByCwd[identity];
    const orderedChanges = requested
      ? requested
          .map((identity) =>
            isReviewEntryId(identity)
              ? findReviewEntry(changes, identity, mode)
              : changes.find((change) => change.path === identity)
          )
          .filter((change): change is WorkingChange => Boolean(change))
      : [
          ...(selectedEntry
            ? changes.filter((change) => reviewEntryId(change, mode) === selectedEntry)
            : []),
          ...changes.filter((change) => reviewEntryId(change, mode) !== selectedEntry)
        ];
    const candidates = orderedChanges
      .filter(
        (change) =>
          change.kind !== 'untracked' || shouldAutoLoadUntrackedDiff(change)
      )
      .slice(0, WorkingDiffStore.PREFETCH_CAP);

    const loadGroup = async (
      group: WorkingChange[],
      base: string | null,
      head: string | null
    ): Promise<void> => {
      const pending = group.filter((change) => {
        const key = this.diffKeyForIdentity(identity, change.path, base, head);
        return !this.diffsByKey[key]?.diff && !this.inflightDiffs.has(key);
      });
      if (pending.length === 0) return;
      const batchRequest = ipc.git.reviewDiffs({
        cwd: trimmed,
        files: pending.map((change) => ({
          path: change.path,
          ...(change.fromPath ? { fromPath: change.fromPath } : {})
        })),
        contextLines,
        ...(base ? { base } : {}),
        ...(head ? { head } : {}),
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
      // Register each batch member before yielding. Overlapping viewport
      // effects now join these promises, and a direct selected-file request
      // joins the same Git process instead of starting a duplicate command.
      const memberRequests = new Map<string, Promise<FileDiff | null>>();
      for (const change of pending) {
        const key = this.diffKeyForIdentity(identity, change.path, base, head);
        const member = batchRequest
          .then((diffs) => diffs.find((diff) => diff.path === change.path) ?? null)
          .catch(() => null);
        memberRequests.set(key, member);
        this.inflightDiffs.set(key, member);
      }

      try {
        const diffs = await batchRequest;
        if (
          contextEpoch !== this.contextEpoch ||
          epoch !== (this.prefetchEpochByCwd.get(identity) ?? 0) ||
          contextLines !== this.contextLines
        ) return;

        const next = { ...this.diffsByKey };
        let changed = false;
        const remembered: Array<{ key: string; pinKey: ReviewEntryId; diff: FileDiff }> = [];
        for (const diff of diffs) {
          const key = this.diffKeyForIdentity(identity, diff.path, base, head);
          const owner = memberRequests.get(key);
          if (!owner || this.inflightDiffs.get(key) !== owner || next[key]?.diff) continue;
          next[key] = {
            diff,
            loading: false,
            error: null,
            generation: ++this.generationCounter
          };
          const source = group.find((change) => change.path === diff.path);
          remembered.push({
            key,
            pinKey: source
              ? reviewEntryId(source, mode)
              : reviewEntryIdFrom(diff.path, base && head ? 'committed' : 'wt', mode),
            diff
          });
          changed = true;
        }
        if (changed) {
          this.diffsByKey = next;
          const evictions: ReviewPayloadEviction[] = [];
          for (const item of remembered) {
            evictions.push(
              ...this.reviewPayloadCache.remember({
                kind: 'diff',
                key: item.key,
                cwd: identity,
                pinKey: item.pinKey,
                bytes: estimateFileDiffBytes(item.diff)
              })
            );
          }
          this.applyReviewPayloadEvictions(evictions);
        }
      } finally {
        for (const [key, owner] of memberRequests) {
          if (this.inflightDiffs.get(key) === owner) this.inflightDiffs.delete(key);
        }
      }
    };

    const workingTree = candidates.filter((change) => change.section !== 'committed');
    const committed = candidates.filter((change) => change.section === 'committed');
    const untracked = workingTree.filter((change) => change.kind === 'untracked');
    const trackedWorkingTree = workingTree.filter((change) => change.kind !== 'untracked');
    await Promise.all([
      loadGroup(trackedWorkingTree, null, null),
      mode?.kind === 'range'
        ? loadGroup(committed, mode.base, mode.head)
        : Promise.resolve(),
      Promise.all(
        untracked.map((change) =>
          this.untrackedDiffAutoloadPool.run(async () => {
            await this.loadDiff(target, change.path, reviewEntrySection(change));
          })
        )
      )
    ]);
  }

  fileLinesKey(
    target: ReviewTarget,
    filePath: string,
    startLine: number,
    endLine: number,
    revision = 'HEAD'
  ): string {
    return this.fileLinesKeyForIdentity(
      this.identityFor(target),
      filePath,
      startLine,
      endLine,
      revision
    );
  }

  fileLinesEntry(
    target: ReviewTarget,
    filePath: string,
    startLine: number,
    endLine: number,
    revision = 'HEAD'
  ): FileLinesEntry {
    const key = this.fileLinesKey(target, filePath, startLine, endLine, revision);
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
    target: ReviewTarget,
    filePath: string,
    startLine: number,
    endLine: number,
    revision = 'HEAD'
  ): Promise<FileLinesEntry> {
    const { cwd: trimmed, identity, context: ctx } = this.resolveTarget(target);
    const idle: FileLinesEntry = { lines: null, totalLines: 0, loading: false, error: null };
    if (!trimmed || !filePath || startLine > endLine) return idle;
    const key = this.fileLinesKeyForIdentity(identity, filePath, startLine, endLine, revision);
    const existing = this.fileLinesByKey[key];
    if (existing?.lines) return existing;
    const inflight = this.inflightFileLines.get(key);
    if (inflight) return inflight;

    this.fileLinesByKey = {
      ...this.fileLinesByKey,
      [key]: { lines: null, totalLines: 0, loading: true, error: null }
    };

    let request!: Promise<FileLinesEntry>;
    request = ipc.git
      .fileLines({
        cwd: trimmed,
        path: filePath,
        revision: revision === 'HEAD'
          ? { kind: 'head' }
          : { kind: 'commit', sha: revision },
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
        if (this.inflightFileLines.get(key) === request) {
          this.fileLinesByKey = { ...this.fileLinesByKey, [key]: entry };
        }
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
        if (this.inflightFileLines.get(key) === request) {
          this.fileLinesByKey = { ...this.fileLinesByKey, [key]: entry };
        }
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

  blameKey(target: ReviewTarget, filePath: string, head: string): string {
    return this.blameKeyForIdentity(this.identityFor(target), filePath, head);
  }

  blameEntry(target: ReviewTarget, filePath: string, head: string): BlameEntry {
    const key = this.blameKey(target, filePath, head);
    this.reviewPayloadCache.touch('blame', key);
    return (
      this.blamesByKey[key] ?? {
        byLine: [],
        loaded: false,
        loading: false,
        error: null
      }
    );
  }

  async loadBlame(target: ReviewTarget, filePath: string, head: string): Promise<BlameEntry> {
    const { cwd: trimmed, identity, context: ctx } = this.resolveTarget(target);
    const idle: BlameEntry = { byLine: [], loaded: false, loading: false, error: null };
    if (!trimmed || !filePath || !head) return idle;
    const key = this.blameKeyForIdentity(identity, filePath, head);
    const mode = this.reviewModeByCwd[identity] ?? { kind: 'working-tree' as const };
    const existing = this.blamesByKey[key];
    if (existing?.loaded && !existing.error) {
      this.reviewPayloadCache.touch('blame', key);
      return existing;
    }
    const inflight = this.inflightBlames.get(key);
    if (inflight) return inflight;

    this.blamesByKey = {
      ...this.blamesByKey,
      [key]: {
        byLine: existing?.byLine ?? [],
        loaded: existing?.loaded ?? false,
        loading: true,
        error: null
      }
    };

    let request!: Promise<BlameEntry>;
    request = ipc.git
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
        const entry: BlameEntry = { byLine, loaded: true, loading: false, error: null };
        if (this.inflightBlames.get(key) === request) {
          this.blamesByKey = { ...this.blamesByKey, [key]: entry };
          this.applyReviewPayloadEvictions(
            this.reviewPayloadCache.remember({
              kind: 'blame',
              key,
              cwd: identity,
              pinKey: reviewEntryIdFrom(filePath, 'committed', mode),
              bytes: estimateBlameBytes(byLine)
            })
          );
        }
        return entry;
      })
      .catch((err: unknown): BlameEntry => {
        const message = err instanceof Error ? err.message : String(err);
        const entry: BlameEntry = {
          byLine: existing?.byLine ?? [],
          loaded: existing?.loaded ?? false,
          loading: false,
          error: message
        };
        if (this.inflightBlames.get(key) === request) {
          this.blamesByKey = { ...this.blamesByKey, [key]: entry };
        }
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
    target: ReviewTarget,
    filePath: string,
    head: string,
    side: 'old' | 'new',
    startLine: number,
    endLine: number
  ): string[] {
    const mode = this.reviewModeByCwd[this.identityFor(target)];
    if (!mode || mode.kind !== 'range') return [];
    const selected = new Set(mode.commits.map((c) => c.hash));
    const blame = this.blameEntry(target, filePath, head).byLine;
    if (blame.length === 0) return [];

    const newLines: number[] = [];
    if (side === 'new') {
      for (let n = startLine; n <= endLine; n += 1) newLines.push(n);
    } else {
      // Map old-side lines through the diff. Only context rows carry both
      // sides, so we mostly recover pairs there; remove-only lines have no
      // new-side counterpart and are intentionally dropped.
      const diff = this.diffEntryFor(target, filePath, mode.base, mode.head).diff;
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

  async stageFiles(scope: ReviewScope, paths: string[]): Promise<void> {
    const { cwd: trimmed, identity, context: ctx } = this.resolveTarget(scope);
    if (!trimmed || !paths.length) return;
    const previous = this.applyStagedLocally(identity, paths, true);
    this.markPending(identity, paths, true);
    this.stageSuppressUntil.set(
      identity,
      Date.now() + WorkingDiffStore.STAGE_SUPPRESS_MS
    );
    try {
      await ipc.git.stageFiles({
        cwd: trimmed,
        paths,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
    } catch (err) {
      if (previous) this.restoreStagedLocally(identity, previous);
      throw err;
    } finally {
      this.markPending(identity, paths, false);
    }
  }

  async unstageFiles(scope: ReviewScope, paths: string[]): Promise<void> {
    const { cwd: trimmed, identity, context: ctx } = this.resolveTarget(scope);
    if (!trimmed || !paths.length) return;
    const previous = this.applyStagedLocally(identity, paths, false);
    this.markPending(identity, paths, true);
    this.stageSuppressUntil.set(
      identity,
      Date.now() + WorkingDiffStore.STAGE_SUPPRESS_MS
    );
    try {
      await ipc.git.unstageFiles({
        cwd: trimmed,
        paths,
        ...(ctx.runMode ? { runMode: ctx.runMode } : {}),
        ...(ctx.wslDistro ? { wslDistro: ctx.wslDistro } : {})
      });
    } catch (err) {
      if (previous) this.restoreStagedLocally(identity, previous);
      throw err;
    } finally {
      this.markPending(identity, paths, false);
    }
  }

  async discardEntries(scope: ReviewScope, entryIds: Iterable<ReviewEntryId>): Promise<void> {
    const { cwd: trimmed, identity, context: ctx } = this.resolveTarget(scope);
    if (!trimmed) return;
    const ids = Array.from(new Set(entryIds));
    if (!ids.length) return;
    const mode = this.reviewModeByCwd[identity] ?? { kind: 'working-tree' as const };
    const snapshot = this.changesByCwd[identity]?.result?.changes ?? [];
    const files = ids.map((entryId) => {
      const entry = findReviewEntry(snapshot, entryId, mode);
      if (!entry || entry.section === 'committed') {
        throw new Error(`Cannot discard stale or non-working-tree entry: ${entryId}`);
      }
      return entry;
    });
    const paths = files.map((f) => f.path);
    this.markPending(identity, paths, true);
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
      this.markPending(identity, paths, false);
    }
  }

  isStagePending(target: ReviewTarget, path: string): boolean {
    return this.pendingStage[`${this.identityFor(target)}::${path}`] === true;
  }

  private markPending(identity: string, paths: string[], pending: boolean): void {
    if (!paths.length) return;
    const next = { ...this.pendingStage };
    let touched = false;
    for (const p of paths) {
      const key = `${identity}::${p}`;
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
    identity: string,
    paths: string[],
    staged: boolean
  ): Map<string, boolean> | null {
    const entry = this.changesByCwd[identity];
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
      [identity]: {
        ...entry,
        result: { ...entry.result, changes: newChanges }
      }
    };
    return previous;
  }

  private restoreStagedLocally(identity: string, previous: Map<string, boolean>): void {
    const entry = this.changesByCwd[identity];
    if (!entry?.result) return;
    const newChanges = entry.result.changes.map((c) =>
      previous.has(c.path) ? { ...c, staged: previous.get(c.path) ?? c.staged } : c
    );
    this.changesByCwd = {
      ...this.changesByCwd,
      [identity]: {
        ...entry,
        result: { ...entry.result, changes: newChanges }
      }
    };
  }

  setContextLines(value: number): void {
    const clamped = Math.max(0, Math.min(50, Math.trunc(value)));
    if (clamped === this.contextLines) return;
    this.contextLines = clamped;
    this.contextEpoch += 1;
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
    this.reviewPayloadCache.clear('diff');
    this.inflightDiffs.clear();
    // Hunk boundaries shift when ctx changes, so existing gap expansions
    // become meaningless. Drop them all and let users re-expand on demand.
    this.fileLinesByKey = {};
    this.inflightFileLines.clear();
  }

  invalidate(target: ReviewTarget): void {
    const { cwd: trimmed, identity } = this.resolveTarget(target);
    if (!trimmed) return;
    this.bumpPrefetchEpoch(identity);
    this.changesEpochByCwd.set(identity, (this.changesEpochByCwd.get(identity) ?? 0) + 1);
    const changesPrefix = `${identity}\u001f`;
    for (const key of Array.from(this.inflightChanges.keys())) {
      if (key.startsWith(changesPrefix)) this.inflightChanges.delete(key);
    }
    // Drop the cached changes entry; next read triggers a fresh fetch.
    if (this.changesByCwd[identity]) {
      const next = { ...this.changesByCwd };
      delete next[identity];
      this.changesByCwd = next;
    }
    // Drop only this worktree's diff entries. Other worktrees of the same
    // repo (e.g., other branches) keep their cached state.
    const prefix = `${identity}::`;
    const remaining: Record<string, DiffEntry> = {};
    for (const [key, entry] of Object.entries(this.diffsByKey)) {
      if (!key.startsWith(prefix)) remaining[key] = entry;
    }
    this.diffsByKey = remaining;
    this.reviewPayloadCache.forgetCwd(identity);
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
  private clearDiffCache(target: ReviewTarget): void {
    const { cwd: trimmed, identity } = this.resolveTarget(target);
    if (!trimmed) return;
    this.bumpPrefetchEpoch(identity);
    const prefix = `${identity}::`;
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
    this.reviewPayloadCache.forgetCwd(identity, 'diff');
    for (const key of Array.from(this.inflightDiffs.keys())) {
      if (key.startsWith(prefix)) this.inflightDiffs.delete(key);
    }
    this.dropFileLines(prefix);
  }

  private applyReviewPayloadEvictions(evictions: ReviewPayloadEviction[]): void {
    if (evictions.length === 0) return;
    let nextDiffs: Record<string, DiffEntry> | null = null;
    let nextBlames: Record<string, BlameEntry> | null = null;
    for (const eviction of evictions) {
      if (eviction.kind === 'diff' && this.diffsByKey[eviction.key]) {
        nextDiffs ??= { ...this.diffsByKey };
        delete nextDiffs[eviction.key];
      } else if (eviction.kind === 'blame' && this.blamesByKey[eviction.key]) {
        nextBlames ??= { ...this.blamesByKey };
        delete nextBlames[eviction.key];
      }
    }
    if (nextDiffs) this.diffsByKey = nextDiffs;
    if (nextBlames) this.blamesByKey = nextBlames;
  }

  private identityFor(target: ReviewTarget): string {
    return this.resolveTarget(target).identity;
  }

  private resolveTarget(target: ReviewTarget): {
    cwd: string;
    identity: string;
    context: RepoContext;
  } {
    if (typeof target !== 'string') {
      const cwd = target.cwd.trim();
      const context: RepoContext = {
        ...(target.runMode ? { runMode: target.runMode } : {}),
        ...(target.wslDistro ? { wslDistro: target.wslDistro } : {})
      };
      return { cwd, identity: worktreeIdentityKey(cwd, context), context };
    }
    const cwd = target.trim();
    const identity = this.currentIdentityByCwd[cwd] ?? worktreeIdentityKey(cwd);
    return { cwd, identity, context: this.contextByIdentity.get(identity) ?? {} };
  }

  private diffKeyForIdentity(
    identity: string,
    filePath: string,
    base?: string | null,
    head?: string | null
  ): string {
    return `${identity}::${filePath}::${base ?? WT_MARKER}::${head ?? WT_MARKER}`;
  }

  private fileLinesKeyForIdentity(
    identity: string,
    filePath: string,
    startLine: number,
    endLine: number,
    revision: string
  ): string {
    return `${identity}::${filePath}::${startLine}-${endLine}::${revision}`;
  }

  private blameKeyForIdentity(identity: string, filePath: string, head: string): string {
    return `${identity}::${filePath}::${head}`;
  }

  private bumpPrefetchEpoch(identity: string): void {
    this.prefetchEpochByCwd.set(identity, (this.prefetchEpochByCwd.get(identity) ?? 0) + 1);
  }

  private suspendReviewDemand(identity: string): void {
    this.bumpPrefetchEpoch(identity);
    this.changesEpochByCwd.set(identity, (this.changesEpochByCwd.get(identity) ?? 0) + 1);
    const requestPrefix = `${identity}\u001f`;
    for (const key of Array.from(this.inflightChanges.keys())) {
      if (key.startsWith(requestPrefix)) this.inflightChanges.delete(key);
    }
    const entry = this.changesByCwd[identity];
    if (entry?.loading) {
      this.changesByCwd = {
        ...this.changesByCwd,
        [identity]: { ...entry, loading: false }
      };
    }
    const payloadPrefix = `${identity}::`;
    for (const key of Array.from(this.inflightDiffs.keys())) {
      if (key.startsWith(payloadPrefix)) this.inflightDiffs.delete(key);
    }
    for (const key of Array.from(this.inflightFileLines.keys())) {
      if (key.startsWith(payloadPrefix)) this.inflightFileLines.delete(key);
    }
    for (const key of Array.from(this.inflightBlames.keys())) {
      if (key.startsWith(payloadPrefix)) this.inflightBlames.delete(key);
    }
  }

  attachListeners(): void {
    this.detach();
    // Consume the Git store's completed observation instead of registering a
    // second filesystem watcher. This keeps status, line counts, and review
    // changes on one coherent generation and one process budget.
    this.detachers.push(
      git.onTick((cwd, observedWorkingTree, cause, context) => {
        const scope = createReviewScope(cwd, context);
        const identity = worktreeIdentityKey(cwd, context);
        // Cache presence is history, not demand. Only a visible Diff or Files
        // Rail Surface may turn a Git observation into review refresh work.
        if ((this.reviewDemandByIdentity.get(identity) ?? 0) === 0) return;
        if (this.isSuppressedStageObservation(identity, cause)) return;
        this.refreshCwd(scope, cause.kind === 'filesystem', observedWorkingTree);
      })
    );
  }

  private isSuppressedStageObservation(identity: string, cause: GitRefreshCause): boolean {
    const suppressUntil = this.stageSuppressUntil.get(identity) ?? 0;
    if (cause.kind === 'filesystem') {
      // Compare the event's causal timestamp, not observation completion. A
      // slow queued refresh must not misclassify an old stage event as new.
      return cause.occurredAt <= suppressUntil;
    }
    return Date.now() <= suppressUntil;
  }

  // `forceDiffRefresh` clears the per-file diff cache regardless of whether
  // the changes list looks identical; used by filesystem-watcher events that
  // already indicate something changed. The polling-tick path passes false
  // and compares signatures so unchanged worktrees don't refetch all diffs
  // every 5s.
  private refreshCwd(
    target: ReviewTarget,
    forceDiffRefresh: boolean,
    observedWorkingTree?: WorkingChangesResult
  ): void {
    const identity = this.identityFor(target);
    const before = this.changesSignature(this.changesByCwd[identity]?.result ?? null);
    void this.loadChanges(target, observedWorkingTree).then((result) => {
      if (!result) return;
      const after = this.changesSignature(result);
      if (forceDiffRefresh || before !== after) {
        this.clearDiffCache(target);
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

function changesRequestKey(cwd: string, mode: ReviewMode | undefined, context: RepoContext): string {
  const review = mode?.kind === 'range'
    ? `range:${mode.base}:${mode.head}:${mode.includeWorkingTree ? 'with-wt' : 'commits-only'}`
    : 'working-tree';
  return [cwd, review, context.runMode ?? '', context.wslDistro ?? ''].join('\u001f');
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

class AsyncTaskPool {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.active += 1;
        void (async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          } finally {
            this.active -= 1;
            this.drain();
          }
        })();
      });
      this.drain();
    });
  }

  private drain(): void {
    const limit = Math.max(1, Math.trunc(this.limit));
    while (this.active < limit && this.queue.length > 0) {
      this.queue.shift()!();
    }
  }
}

export const workingDiff = new WorkingDiffStore();
