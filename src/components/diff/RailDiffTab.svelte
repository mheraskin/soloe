<script lang="ts">
  import {
    GitCompare,
    GitCommit as GitCommitIcon,
    Loader2,
    AlertCircle,
    RefreshCw,
    Search,
    Rows,
    Columns,
    FileDiff,
    Plus,
    Minus,
    Maximize2,
    Minimize2,
    MoreHorizontal,
    WrapText,
    MessageSquare,
    ChevronsUp,
    ChevronsDown,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    RotateCcw,
    FoldVertical,
    UnfoldVertical,
    X
  } from '@lucide/svelte';
  import { onMount, untrack } from 'svelte';
  import type { DiffHunk } from '@shared/types/git.js';
  import { worktreeScopeKey } from '@shared/worktree-identity.js';
  import { sessions } from '../../stores/sessions.svelte';
  import {
    createReviewScope,
    workingDiff,
    type ReviewScope
  } from '../../stores/working-diff.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';

  let compactViewport = $state(window.matchMedia('(max-width: 767px)').matches);
  import { settings } from '../../stores/settings.svelte';
  import { confirmStore } from '../../stores/confirm.svelte';
  import type { WorkingChange } from '@shared/types/git.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Popover from '$lib/components/ui/popover';
  import ChangeRow from './ChangeRow.svelte';
  import DiffLoadPlaceholder from './DiffLoadPlaceholder.svelte';
  import VirtualDiffBody from './VirtualDiffBody.svelte';
  import RailCommentsPanel from './RailCommentsPanel.svelte';
  import DiffSelectionMenu from './DiffSelectionMenu.svelte';
  import CommitPicker from './CommitPicker.svelte';
  import CommitComposer from './CommitComposer.svelte';
  import { estimateReviewBodyHeight, ReviewViewport } from '$lib/review-viewport.svelte';
  import {
    resolveReviewSelectionTarget,
    type ReviewSelectionTarget
  } from '$lib/diff-selection';
  import {
    findReviewEntry,
    reviewEntryId,
    reviewEntryPath,
    reviewEntrySection,
    type ReviewEntryId
  } from '$lib/review-entry';

  let diffRootEl: HTMLDivElement | null = $state(null);
  let diffViewportEl: HTMLElement | null = $state(null);
  const reviewViewport = new ReviewViewport();

  $effect(() => reviewViewport.attach(diffViewportEl));

  // Auto-fit by default: 4 full rows + half of the 5th when there are more,
  // otherwise just enough for whatever's there. The user can still drag to
  // override; their value is persisted. Key bumped to v2 to discard the old
  // 220px floor so existing users get the new auto-fit behaviour.
  const LIST_HEIGHT_KEY = 'soloe.diffListHeight.v2';
  const MIN_LIST_HEIGHT = 60;
  const MAX_LIST_HEIGHT = 640;
  const ROW_HEIGHT_PX = 36;
  const LIST_VERTICAL_PADDING_PX = 12;
  const GROUP_HEADER_PX = 24;
  const CHANGE_RENDER_BATCH_SIZE = 8;
  let userListHeightOverride = $state<number | null>(null);
  let resizingList = $state(false);
  let resizeStartY = 0;
  let resizeStartHeight = 0;
  let diffExpanded = $state(false);

  type FilterValue = 'all' | 'staged' | 'unstaged' | 'untracked' | 'wt' | 'committed';

  const WT_FILTER_OPTIONS: ReadonlyArray<{ id: FilterValue; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'staged', label: 'Staged' },
    { id: 'unstaged', label: 'Unstaged' },
    { id: 'untracked', label: 'New' }
  ];

  const RANGE_FILTER_OPTIONS: ReadonlyArray<{ id: FilterValue; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'wt', label: 'Working tree' },
    { id: 'committed', label: 'Commits' }
  ];

  let selected = $derived(sessions.selected);

  // The worktree cwd anchors every store key. We register run-mode + WSL distro
  // so the IPC layer can dispatch to native or WSL git as appropriate.
  let activeCwd = $derived.by<string | null>(() => {
    const cwd = selected?.cwd?.trim();
    return cwd && cwd.length > 0 ? cwd : null;
  });

  let activeReviewScope = $derived.by<ReviewScope | null>(() => {
    if (!activeCwd || !selected) return null;
    return createReviewScope(activeCwd, {
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    });
  });

  $effect(() => {
    const scope = activeReviewScope;
    if (!scope) return;
    return workingDiff.acquireReviewDemand(scope);
  });

  let changesEntry = $derived(activeReviewScope ? workingDiff.changesFor(activeReviewScope) : null);
  let filteredChanges = $derived(activeReviewScope ? workingDiff.filteredChangesFor(activeReviewScope) : []);
  let totalChangeCount = $derived(changesEntry?.result?.changes.length ?? 0);
  let stagedChanges = $derived(filteredChanges.filter((c) => c.staged && c.section !== 'committed'));
  let unstagedChanges = $derived(filteredChanges.filter((c) => !c.staged && c.section !== 'committed'));

  let reviewMode = $derived(
    activeReviewScope ? workingDiff.reviewModeFor(activeReviewScope) : ({ kind: 'working-tree' } as const)
  );
  let selectionContextKey = $derived.by(() => {
    const scope = activeReviewScope;
    if (!scope) return 'no-review';
    const modeKey = reviewMode.kind === 'range'
      ? `range\0${reviewMode.base}\0${reviewMode.head}`
      : 'working-tree';
    return `${worktreeScopeKey(scope)}\0${modeKey}`;
  });
  let selectionMenuActive = $derived(
    rightRail.openTabs.includes('diff') &&
      (!rightRail.fullscreen || rightRail.fullscreenTab === 'diff')
  );
  let selectionGeometryVersion = $derived(
    `${reviewViewport.scrollVersion}:${reviewViewport.layoutVersion}`
  );
  let isRangeMode = $derived(reviewMode.kind === 'range');
  let filterOptions = $derived(isRangeMode ? RANGE_FILTER_OPTIONS : WT_FILTER_OPTIONS);

  // In range mode the file list groups by section (Working tree vs Commits);
  // in working-tree mode the original staged/unstaged grouping kicks in only
  // when the user is on the "all" pill (otherwise the list is already filtered).
  let wtSectionChanges = $derived(
    filteredChanges.filter((c) => c.section !== 'committed')
  );
  let committedSectionChanges = $derived(
    filteredChanges.filter((c) => c.section === 'committed')
  );
  let showRangeGroups = $derived(isRangeMode);
  let showWtModeGroups = $derived(
    !isRangeMode &&
      workingDiff.filter === 'all' &&
      (stagedChanges.length > 0 || unstagedChanges.length > 0)
  );

  // Stack order mirrors the file list ordering so clicking a row scrolls to
  // the same index in the diff. In range mode we go working tree first, then
  // committed; in WT mode we keep the staged → unstaged grouping.
  let stackChanges = $derived(
    showRangeGroups
      ? [...wtSectionChanges, ...committedSectionChanges]
      : showWtModeGroups
        ? [...stagedChanges, ...unstagedChanges]
        : filteredChanges
  );

  // A large review used to mount every file twice in one update: once in the
  // compact picker and once as a review section. Diff bodies are viewport
  // resident, but constructing all of those outer components still produced a
  // long renderer task. Keep the complete review model while yielding between
  // small DOM batches so controls, scrolling, and loading feedback stay live.
  let changeRenderBatch = $state({ key: '', limit: 0 });
  let changeRenderKey = $derived.by(() => {
    const entries = stackChanges
      .map((change) => reviewEntryId(change, reviewMode))
      .join('\0');
    return `${selectionContextKey}\0${entries}`;
  });
  let renderedChangeCount = $derived(
    Math.min(
      stackChanges.length,
      changeRenderBatch.key === changeRenderKey
        ? changeRenderBatch.limit
        : CHANGE_RENDER_BATCH_SIZE
    )
  );
  let renderingChanges = $derived(renderedChangeCount < stackChanges.length);
  let renderedStackChanges = $derived(stackChanges.slice(0, renderedChangeCount));
  let renderedWtSectionChanges = $derived(
    renderedStackChanges.filter((change) => change.section !== 'committed')
  );
  let renderedCommittedSectionChanges = $derived(
    renderedStackChanges.filter((change) => change.section === 'committed')
  );
  let renderedStagedChanges = $derived(
    renderedStackChanges.filter((change) => change.staged && change.section !== 'committed')
  );
  let renderedUnstagedChanges = $derived(
    renderedStackChanges.filter((change) => !change.staged && change.section !== 'committed')
  );

  $effect(() => {
    const key = changeRenderKey;
    const total = stackChanges.length;
    const initialLimit = Math.min(total, CHANGE_RENDER_BATCH_SIZE);
    untrack(() => {
      changeRenderBatch = { key, limit: initialLimit };
    });
    if (initialLimit >= total) return;

    let frame = requestAnimationFrame(appendBatch);
    function appendBatch(): void {
      if (changeRenderBatch.key !== key) return;
      const limit = Math.min(total, changeRenderBatch.limit + CHANGE_RENDER_BATCH_SIZE);
      changeRenderBatch = { key, limit };
      if (limit < total) frame = requestAnimationFrame(appendBatch);
    }

    return () => cancelAnimationFrame(frame);
  });

  let commitScopeText = $derived.by<string>(() => {
    if (reviewMode.kind !== 'range') return 'Working tree';
    const n = reviewMode.commits.length;
    const shortBase = reviewMode.base.slice(0, 7);
    const shortHead = reviewMode.head.slice(0, 7);
    return `${n} commit${n === 1 ? '' : 's'} · ${shortBase}…${shortHead}`;
  });
  let chipFilterShort = $derived(
    reviewMode.kind === 'range' && reviewMode.chipFilter ? reviewMode.chipFilter.slice(0, 7) : null
  );

  let pickerOpen = $state(false);

  function clearChipFilter(): void {
    if (!activeReviewScope) return;
    workingDiff.setChipFilter(activeReviewScope, null);
  }

  function pickCommitChip(sha: string): void {
    if (!activeReviewScope) return;
    workingDiff.setChipFilter(activeReviewScope, reviewMode.kind === 'range' && reviewMode.chipFilter === sha ? null : sha);
  }

  let storedSelected = $derived(activeReviewScope ? workingDiff.selectedReviewEntry(activeReviewScope) : null);
  // Multi-file viewer renders the filtered set as a scroll stack; the
  // "selected" file is the one currently in view (highlight + active for
  // outside integrations). Anything outside the filter can't be the active
  // one because it isn't rendered.
  let effectiveSelected = $derived.by<ReviewEntryId | null>(() => {
    if (
      storedSelected &&
      filteredChanges.some((change) => reviewEntryId(change, reviewMode) === storedSelected)
    ) {
      return storedSelected;
    }
    if (!filteredChanges.length) return null;
    return reviewEntryId(filteredChanges[0]!, reviewMode);
  });
  let effectiveSelectedChange = $derived(
    effectiveSelected
      ? findReviewEntry(filteredChanges, effectiveSelected, reviewMode) ?? null
      : null
  );
  let effectiveSelectedPath = $derived(
    effectiveSelected ? reviewEntryPath(effectiveSelected) : null
  );

  $effect(() => {
    if (!activeCwd) return;
    const next = effectiveSelected;
    if (next && next !== storedSelected) {
      const change = findReviewEntry(filteredChanges, next, reviewMode);
      if (change && activeReviewScope) workingDiff.setSelectedEntry(activeReviewScope, change);
    }
  });

  // Per-file refs power the scroll-stacked viewer: each file section reports
  // its position so virtualization stays correct and click-to-scroll lands on
  // the right anchor. Actions register/unregister and bump layoutTick so the
  // sectionTops derived recomputes — ResizeObserver covers the rest.
  let sectionEls = $state<Record<string, HTMLDivElement | null>>({});
  let bodyWrapperEls = $state<Record<string, HTMLDivElement | null>>({});
  let layoutTick = $state(0);

  function bindSection(node: HTMLDivElement, path: string) {
    const viewportRegistration = reviewViewport.registerSection(node, path);
    sectionEls[path] = node;
    layoutTick++;
    let current = path;
    return {
      update(newPath: string) {
        if (newPath === current) return;
        sectionEls[current] = null;
        current = newPath;
        sectionEls[current] = node;
        viewportRegistration.update(current);
        layoutTick++;
      },
      destroy() {
        viewportRegistration.destroy();
        sectionEls[current] = null;
        layoutTick++;
      }
    };
  }

  function bindBodyWrapper(node: HTMLDivElement, path: string) {
    const viewportRegistration = reviewViewport.registerBody(node, path);
    bodyWrapperEls[path] = node;
    layoutTick++;
    let current = path;
    return {
      update(newPath: string) {
        if (newPath === current) return;
        bodyWrapperEls[current] = null;
        current = newPath;
        bodyWrapperEls[current] = node;
        viewportRegistration.update(current);
        layoutTick++;
      },
      destroy() {
        viewportRegistration.destroy();
        bodyWrapperEls[current] = null;
        layoutTick++;
      }
    };
  }

  // The `layoutTick++` writes here look harmless, but `x++` is `x = x + 1` —
  // the right side reads `layoutTick`, which subscribes the effect to its
  // own write and self-loops under Svelte 5 prod-build cycle detection
  // (dev mode batches it away). Wrap the increments in `untrack` so the
  // read doesn't take a dependency. ResizeObserver/action callbacks are
  // already safe because they run outside an effect's tracking scope.
  $effect(() => {
    void stackChanges;
    void workingDiff.wordWrap;
    void workingDiff.viewMode;
    untrack(() => {
      layoutTick++;
    });
  });

  // Per-entry collapse state. Keyed by cwd + immutable ReviewEntryId so WT
  // and committed rows for the same path remain independently controllable.
  // across worktree switches without spilling between them. Staged files are
  // auto-seeded collapsed (see effect below) so a big mechanical staged diff
  // doesn't drown out the unstaged review; once the user toggles, their
  // preference wins for the rest of the session.
  let collapsedByPath = $state<Record<string, boolean>>({});
  // Plain Set: non-reactive memory of which (cwd,path) pairs have already
  // been considered for the staged-seed rule. Stays out of the dependency
  // graph so the seeding effect below doesn't read what it writes.
  const collapseSeedSeen = new Set<string>();

  function collapseKey(entryId: ReviewEntryId): string {
    return `${activeCwd ?? '__none__'}::${entryId}`;
  }

  function isCollapsed(change: WorkingChange): boolean {
    return collapsedByPath[collapseKey(reviewEntryId(change, reviewMode))] === true;
  }

  function toggleCollapsed(change: WorkingChange): void {
    const entryId = reviewEntryId(change, reviewMode);
    const key = collapseKey(entryId);
    const next = { ...collapsedByPath };
    if (next[key]) {
      delete next[key];
    } else {
      reviewViewport.scrollSectionToTop(entryId);
      next[key] = true;
    }
    collapsedByPath = next;
  }

  function loadReviewDiff(change: WorkingChange): void {
    const scope = activeReviewScope;
    if (!scope) return;
    void workingDiff
      .loadDiff(scope, change.path, reviewEntrySection(change))
      .catch(reportError);
  }

  let allCollapsed = $derived.by<boolean>(() => {
    if (stackChanges.length === 0) return false;
    return stackChanges.every(
      (change) => collapsedByPath[collapseKey(reviewEntryId(change, reviewMode))] === true
    );
  });

  function toggleAllCollapsed(): void {
    const target = !allCollapsed;
    const next = { ...collapsedByPath };
    for (const c of stackChanges) {
      const key = collapseKey(reviewEntryId(c, reviewMode));
      if (target) next[key] = true;
      else delete next[key];
    }
    collapsedByPath = next;
  }

  // The shared ReviewViewport keeps only a pixel-local window resident. The
  // selected file and a pending comment reveal are pins so navigation never
  // waits for IntersectionObserver to catch up after a far jump.
  let residentEntries = $derived.by<ReadonlySet<ReviewEntryId>>(() => {
    const near = reviewViewport.nearPaths;
    const highlighted = diffComments.highlight;
    const out = new Set<ReviewEntryId>();
    for (const change of stackChanges) {
      if (isCollapsed(change)) continue;
      const entryId = reviewEntryId(change, reviewMode);
      if (
        near.has(entryId) ||
        entryId === effectiveSelected ||
        (highlighted && activeReviewScope &&
          worktreeScopeKey(highlighted.scope) === worktreeScopeKey(activeReviewScope) &&
          highlighted.filePath === change.path &&
          highlighted.section === reviewEntrySection(change))
      ) {
        out.add(entryId);
      }
    }
    return out;
  });

  // Residency is also the pin set for the bounded payload cache. Updating it
  // atomically lets the cache evict the previous review's cold LRU entries
  // without dropping the file currently being rendered or revealed.
  $effect(() => {
    const scope = activeReviewScope;
    const entries = Array.from(residentEntries);
    untrack(() => workingDiff.setReviewResidents(scope, entries));
  });

  // Selection describes navigation intent; residency determines allocation.
  // In particular, a staged file can be selected yet auto-collapsed, and
  // fetching its body would consume Git/IPC/heap resources for invisible UI.
  $effect(() => {
    const scope = activeReviewScope;
    const selected = effectiveSelectedChange;
    if (!scope || !selected || !residentEntries.has(reviewEntryId(selected, reviewMode))) return;
    void workingDiff
      .loadDiff(scope, selected.path, reviewEntrySection(selected))
      .catch(reportError);
  });

  // A comment reveal is a semantic navigation request, not just a flash.
  // Ensure a previously collapsed target can mount before VirtualDiffBody
  // resolves and scrolls to the exact line range.
  $effect(() => {
    const highlighted = diffComments.highlight;
    const scope = activeReviewScope;
    if (
      !highlighted ||
      !scope ||
      worktreeScopeKey(highlighted.scope) !== worktreeScopeKey(scope)
    ) return;
    const target = effectiveSelectedChange?.path === highlighted.filePath &&
      reviewEntrySection(effectiveSelectedChange) === highlighted.section
      ? effectiveSelectedChange
      : stackChanges.find(
          (change) =>
            change.path === highlighted.filePath &&
            reviewEntrySection(change) === highlighted.section
        );
    if (!target) return;
    const key = collapseKey(reviewEntryId(target, reviewMode));
    if (!collapsedByPath[key]) return;
    untrack(() => {
      const next = { ...collapsedByPath };
      delete next[key];
      collapsedByPath = next;
    });
  });

  // Materialize only the resident review window. The main-side Adapter still
  // batches these into one patch per Git range, retaining process efficiency
  // without shipping up to 200 off-screen diffs through IPC.
  $effect(() => {
    const scope = activeReviewScope;
    const selectedEntry = effectiveSelected;
    const entries = Array.from(residentEntries).filter((entryId) => entryId !== selectedEntry);
    void changesEntry?.result;
    void workingDiff.contextLines;
    if (!scope || entries.length === 0) return;
    void workingDiff.prefetchDiffs(scope, entries).catch(reportError);
  });

  // Only resident bodies need geometry reads. The previous implementation
  // synchronously measured every file after any root resize, making layout
  // work linear in review size even though row rendering was virtualized.
  let sectionTops = $derived.by<Record<string, number>>(() => {
    void layoutTick;
    void reviewViewport.layoutVersion;
    const out: Record<string, number> = {};
    const root = diffRootEl;
    if (!root) return out;
    const rootRect = root.getBoundingClientRect();
    for (const entryId of residentEntries) {
      const wrapper = bodyWrapperEls[entryId];
      if (!wrapper) continue;
      out[entryId] = wrapper.getBoundingClientRect().top - rootRect.top;
    }
    return out;
  });

  // Staged-file auto-collapse seed. The `untrack` here keeps us from
  // subscribing to our own write of `collapsedByPath` — `{...collapsedByPath}`
  // would otherwise re-trigger this effect under Svelte 5 prod cycle
  // detection (same self-loop pattern as `layoutTick++`).
  $effect(() => {
    if (!activeCwd) return;
    let pending: string[] | null = null;
    for (const change of stackChanges) {
      if (!change.staged) continue;
      const key = collapseKey(reviewEntryId(change, reviewMode));
      if (collapseSeedSeen.has(key)) continue;
      collapseSeedSeen.add(key);
      if (!pending) pending = [];
      pending.push(key);
    }
    if (pending) {
      const additions = pending;
      untrack(() => {
        const next = { ...collapsedByPath };
        for (const key of additions) next[key] = true;
        collapsedByPath = next;
      });
    }
  });

  // Reconcile the outdated set per file. Comments whose anchored text no
  // longer matches the live diff land in the Outdated panel and stop
  // rendering markers; running this for every loaded diff keeps outdated
  // detection in sync even when the user hasn't scrolled to that file yet.
  $effect(() => {
    const scope = activeReviewScope;
    if (!scope) return;
    for (const change of filteredChanges) {
      const committed = change.section === 'committed' && reviewMode.kind === 'range';
      const entry = workingDiff.diffEntryFor(
        scope,
        change.path,
        committed ? reviewMode.base : null,
        committed ? reviewMode.head : null
      );
      if (entry?.diff) {
        diffComments.recomputeOutdated(
          scope,
          change.path,
          entry.diff,
          reviewEntrySection(change)
        );
      }
    }
  });

  function gutterWidthFor(hunks: DiffHunk[] | undefined): number {
    if (!hunks) return 2;
    let max = 0;
    for (const hunk of hunks) {
      const oldEnd = hunk.oldStart + hunk.oldCount;
      const newEnd = hunk.newStart + hunk.newCount;
      if (oldEnd > max) max = oldEnd;
      if (newEnd > max) max = newEnd;
    }
    return Math.max(2, String(max).length);
  }

  function selectionTargetForEntry(entryId: string): ReviewSelectionTarget | null {
    const scope = activeReviewScope;
    if (!scope) return null;
    return resolveReviewSelectionTarget(scope, stackChanges, entryId, reviewMode, (change) => {
      const committed = change.section === 'committed' && reviewMode.kind === 'range';
      return workingDiff.diffEntryFor(
        scope,
        change.path,
        committed ? reviewMode.base : null,
        committed ? reviewMode.head : null
      ).diff;
    });
  }

  let queryDraft = $state(workingDiff.query);

  function commitQuery(): void {
    workingDiff.query = queryDraft;
  }

  // The single Comments rail consolidates Active/Outdated/Resolved tabs and
  // owns the per-comment Send affordances; this tab just toggles it open.
  // The toggle's count reflects unresolved threads only — resolved ones are
  // still reachable inside the panel but stay out of the headline number.
  let totalCommentCount = $derived(
    activeReviewScope
      ? diffComments.forWorktree(activeReviewScope).filter((c) => !c.resolvedAt).length
      : 0
  );
  let showComments = $state(false);

  // Natural height fits up to 4 rows; if there's a 5th, peek half of it so
  // the splitter signals "more below" instead of blank space.
  let naturalListHeight = $derived.by<number>(() => {
    const count = filteredChanges.length;
    if (count === 0) return MIN_LIST_HEIGHT;
    const visibleRows = Math.min(count, 4);
    const peek = count > 4 ? 0.5 : 0;
    const headerCount = showRangeGroups
      ? (wtSectionChanges.length > 0 ? 1 : 0) + (committedSectionChanges.length > 0 ? 1 : 0)
      : showWtModeGroups
        ? (stagedChanges.length > 0 ? 1 : 0) + (unstagedChanges.length > 0 ? 1 : 0)
        : 0;
    return Math.round(
      LIST_VERTICAL_PADDING_PX
        + visibleRows * ROW_HEIGHT_PX
        + peek * ROW_HEIGHT_PX
        + headerCount * GROUP_HEADER_PX
    );
  });

  let listHeight = $derived(
    userListHeightOverride !== null ? userListHeightOverride : naturalListHeight
  );

  function pickChange(change: WorkingChange): void {
    if (!activeCwd) return;
    const entryId = reviewEntryId(change, reviewMode);
    workingDiff.setSelectedEntry(activeReviewScope ?? activeCwd, change);
    // Expand the picked file so the click actually reveals content rather
    // than scrolling to a still-collapsed header.
    const key = collapseKey(entryId);
    if (collapsedByPath[key]) {
      const next = { ...collapsedByPath };
      delete next[key];
      collapsedByPath = next;
    }
    const section = sectionEls[entryId];
    const viewport = diffViewportEl;
    if (!section || !viewport) return;
    const sectionRect = section.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const top = viewport.scrollTop + sectionRect.top - viewportRect.top;
    viewport.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  async function stageFile(path: string): Promise<void> {
    const scope = activeReviewScope;
    if (!scope) return;
    await workingDiff.stageFiles(scope, [path]);
  }

  async function unstageFile(path: string): Promise<void> {
    const scope = activeReviewScope;
    if (!scope) return;
    await workingDiff.unstageFiles(scope, [path]);
  }

  async function stageAll(): Promise<void> {
    const scope = activeReviewScope;
    if (!scope) return;
    const paths = unstagedChanges.map((c) => c.path);
    if (paths.length) await workingDiff.stageFiles(scope, paths);
  }

  async function unstageAll(): Promise<void> {
    const scope = activeReviewScope;
    if (!scope) return;
    const paths = stagedChanges.map((c) => c.path);
    if (paths.length) await workingDiff.unstageFiles(scope, paths);
  }

  // Destructive: discarding rewrites the working tree from HEAD (or removes
  // untracked/added files outright). Always gate on a danger confirm — this
  // is the same pattern other delete-style flows use.
  async function discardChange(change: WorkingChange): Promise<void> {
    const scope = activeReviewScope;
    if (!scope) return;
    const entryId = reviewEntryId(change, reviewMode);
    const verb = change.kind === 'untracked' || change.kind === 'added' ? 'delete' : 'discard changes to';
    const ok = await confirmStore.ask({
      title: 'Discard changes',
      message: `Are you sure you want to ${verb} ${change.path}? This cannot be undone.`,
      confirmLabel: 'Discard',
      cancelLabel: 'Cancel',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await workingDiff.discardEntries(scope, [entryId]);
    } catch (err) {
      reportError(err);
    }
  }

  // Every working-tree change regardless of the active filter pill — "discard
  // all" wipes the whole working tree, not just the currently-shown subset.
  // Committed-section entries (range mode) are excluded; they aren't editable.
  let allWtChanges = $derived(
    (changesEntry?.result?.changes ?? []).filter((c) => c.section !== 'committed')
  );

  async function discardAll(): Promise<void> {
    const scope = activeReviewScope;
    if (!scope) return;
    const targets = allWtChanges;
    const entryIds = targets.map((change) => reviewEntryId(change, reviewMode));
    if (targets.length === 0) return;
    const ok = await confirmStore.ask({
      title: 'Discard all changes',
      message: `Discard all ${targets.length} working-tree change${targets.length === 1 ? '' : 's'}? Tracked files revert to HEAD and new files are deleted. This cannot be undone.`,
      confirmLabel: 'Discard all',
      cancelLabel: 'Cancel',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await workingDiff.discardEntries(scope, entryIds);
    } catch (err) {
      reportError(err);
    }
  }

  async function refresh(): Promise<void> {
    const scope = activeReviewScope;
    if (!scope) return;
    workingDiff.invalidate(scope);
    try {
      await workingDiff.loadChanges(scope);
    } catch (err) {
      reportError(err);
    }
  }

  function clampContext(value: number): number {
    return Math.max(0, Math.min(50, Math.trunc(value)));
  }

  function setContextLines(value: number): void {
    // The store clears every diff body and bumps generations; the prefetch
    // effect below re-primes the cache against the new context-lines value
    // (active file first), so we don't need to issue a manual fetch here.
    workingDiff.setContextLines(clampContext(value));
  }

  let searchInputEl: HTMLInputElement | null = $state(null);

  function clampListHeight(value: number): number {
    return Math.max(MIN_LIST_HEIGHT, Math.min(MAX_LIST_HEIGHT, Math.round(value)));
  }

  function startResizeList(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    resizingList = true;
    resizeStartY = event.clientY;
    resizeStartHeight = listHeight;
    window.addEventListener('pointermove', resizeList);
    window.addEventListener('pointerup', stopResizeList, { once: true });
  }

  function resizeList(event: PointerEvent): void {
    userListHeightOverride = clampListHeight(resizeStartHeight + (event.clientY - resizeStartY));
  }

  function stopResizeList(): void {
    resizingList = false;
    window.removeEventListener('pointermove', resizeList);
    if (userListHeightOverride !== null) {
      localStorage.setItem(LIST_HEIGHT_KEY, String(userListHeightOverride));
    }
  }

  // Per-cwd diff scroll persistence. Save on scroll (debounced), restore on
  // cwd swap. Restore retries until diffRootEl is tall enough to accept the
  // saved offset — diffs load async, so a single setTimeout would land
  // before content was ready. Capped so we don't poll forever on a worktree
  // whose stack genuinely doesn't reach the saved offset.
  let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;
  let restoreDeadline = 0;
  const SCROLL_SAVE_DEBOUNCE_MS = 150;
  const RESTORE_TIMEOUT_MS = 3000;
  const RESTORE_POLL_MS = 80;

  function cancelRestore(): void {
    if (restoreTimer !== null) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  }

  function tryRestoreScroll(target: number): void {
    const v = diffViewportEl;
    if (!v) {
      if (Date.now() < restoreDeadline) {
        restoreTimer = setTimeout(() => tryRestoreScroll(target), RESTORE_POLL_MS);
      }
      return;
    }
    const max = v.scrollHeight - v.clientHeight;
    if (max >= target || Date.now() >= restoreDeadline) {
      v.scrollTo({ top: Math.min(Math.max(0, target), Math.max(0, max)), behavior: 'instant' });
      restoreTimer = null;
      return;
    }
    restoreTimer = setTimeout(() => tryRestoreScroll(target), RESTORE_POLL_MS);
  }

  $effect(() => {
    const cwd = activeCwd;
    cancelRestore();
    if (!cwd) return;
    // Read saved offset eagerly (untrack to keep this effect from re-firing
    // on writes back to the same key).
    const target = untrack(() => rightRail.getDiffScrollTop(cwd));
    if (target <= 0) return;
    restoreDeadline = Date.now() + RESTORE_TIMEOUT_MS;
    restoreTimer = setTimeout(() => tryRestoreScroll(target), RESTORE_POLL_MS);
    return () => cancelRestore();
  });

  $effect(() => {
    const cwd = activeCwd;
    if (!cwd) return;
    return reviewViewport.subscribeScroll((scrollTop) => {
      // User input wins — abort any pending restore so we don't clobber it.
      if (restoreTimer !== null) cancelRestore();
      if (scrollSaveTimer !== null) clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => {
        scrollSaveTimer = null;
        rightRail.setDiffScrollTop(cwd, scrollTop);
      }, SCROLL_SAVE_DEBOUNCE_MS);
    });
  });

  $effect(() => {
    return () => {
      if (scrollSaveTimer !== null) {
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = null;
      }
    };
  });

  onMount(() => {
    const compactMedia = window.matchMedia('(max-width: 767px)');
    const updateCompactViewport = () => {
      compactViewport = compactMedia.matches;
    };
    compactMedia.addEventListener('change', updateCompactViewport);

    const raw = localStorage.getItem(LIST_HEIGHT_KEY);
    if (raw !== null) {
      const stored = Number(raw);
      if (Number.isFinite(stored) && stored > 0) {
        userListHeightOverride = clampListHeight(stored);
      }
    }
    const focusSearch = () => {
      searchInputEl?.focus();
      searchInputEl?.select();
    };
    const onRefocus = () => {
      if (rightRail.activeTab !== 'diff') return;
      focusSearch();
    };
    const onFocusPane = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId: string }>).detail;
      if (detail?.tabId !== 'diff') return;
      focusSearch();
    };
    window.addEventListener('soloe:refocus-rail', onRefocus);
    window.addEventListener('soloe:focus-pane', onFocusPane);
    // Single document-level mouseup finalizes any in-progress gutter drag
    // started inside a virtual diff body. Without this, releasing the cursor outside
    // a gutter cell would leave the selection stuck in dragging state.
    // Use the selection's own file rather than the active one — drag may
    // have started in a file that isn't the topmost in the viewport.
    const onDocMouseup = () => {
      const sel = diffComments.selection;
      if (!sel?.dragging) return;
      const scope = sel.scope;
      const selectionMode = workingDiff.reviewModeFor(scope);
      const committed = sel.section === 'committed' && selectionMode.kind === 'range';
      const entry = workingDiff.diffEntryFor(
        scope,
        sel.filePath,
        committed ? selectionMode.base : null,
        committed ? selectionMode.head : null
      );
      diffComments.endSelectionAndCreate(entry?.diff ?? null);
    };
    window.addEventListener('mouseup', onDocMouseup);
    return () => {
      compactMedia.removeEventListener('change', updateCompactViewport);
      window.removeEventListener('soloe:refocus-rail', onRefocus);
      window.removeEventListener('soloe:focus-pane', onFocusPane);
      window.removeEventListener('mouseup', onDocMouseup);
      workingDiff.setReviewResidents(null, []);
    };
  });
</script>

<div class="mobile-diff-surface flex min-h-0 min-w-0 flex-1 flex-col" class:select-none={resizingList}>
  <header class="mobile-rail-header soloe-pane-header min-w-0 justify-between">
    <div class="flex min-w-0 flex-1 items-center">
      <Popover.Root bind:open={pickerOpen}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="xs"
              class="min-w-0 justify-start gap-1.5"
              aria-label="Choose review range"
              title={isRangeMode
                ? `Review range — ${commitScopeText}`
                : 'Working tree — pick commits to review'}
              disabled={!activeCwd}
            >
              {#if isRangeMode}
                <GitCommitIcon class="size-3 shrink-0" />
              {:else}
                <GitCompare class="size-3 shrink-0" />
              {/if}
              <span class="min-w-0 truncate">{commitScopeText}</span>
              {#if chipFilterShort}
                <span class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                  {chipFilterShort}
                </span>
              {/if}
              <ChevronDown class="size-3 shrink-0 opacity-60" />
            </Button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content align="start" class="w-auto p-0">
          {#if activeCwd}
            {#key worktreeScopeKey(activeReviewScope!)}
              <CommitPicker scope={activeReviewScope!} onClose={() => (pickerOpen = false)} />
            {/key}
          {/if}
        </Popover.Content>
      </Popover.Root>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      {#if showComments}
        <Button
          variant="ghost"
          size="xs"
          onclick={() => (showComments = false)}
          title="Back to diff"
          aria-label="Back to diff"
        >
          <ChevronLeft class="size-3" />
          <span>Back</span>
        </Button>
      {:else if totalCommentCount > 0}
        <Button
          variant="ghost"
          size="xs"
          onclick={() => (showComments = true)}
          title="Comments"
          aria-label="Show comments"
        >
          <MessageSquare class="size-3" />
          <span>Comments ({totalCommentCount})</span>
        </Button>
      {/if}
      {#if chipFilterShort}
        <Button
          variant="ghost"
          size="xs"
          onclick={clearChipFilter}
          aria-label="Clear commit filter"
          title="Clear commit filter"
        >
          <X class="size-3" />
        </Button>
      {/if}
      <Button
        variant="ghost"
        size="xs"
        onclick={() => (diffExpanded = !diffExpanded)}
        aria-label={diffExpanded ? 'Show file list' : 'Hide file list'}
        title={diffExpanded ? 'Show file list & commit' : 'Hide file list & commit'}
        aria-pressed={diffExpanded}
        disabled={!activeCwd}
      >
        {#if diffExpanded}
          <ChevronsDown class="size-3" />
        {:else}
          <ChevronsUp class="size-3" />
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onclick={() => rightRail.toggleFullscreen()}
        aria-label={rightRail.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        title={rightRail.fullscreen ? 'Exit fullscreen (Ctrl+Shift+M)' : 'Fullscreen (Ctrl+Shift+M)'}
        aria-pressed={rightRail.fullscreen}
      >
        {#if rightRail.fullscreen}
          <Minimize2 class="size-3" />
        {:else}
          <Maximize2 class="size-3" />
        {/if}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="xs"
              aria-label="More diff actions"
              title="More"
              disabled={!activeCwd}
            >
              <MoreHorizontal class="size-3" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-52">
          <DropdownMenu.Item
            disabled={!activeCwd || compactViewport}
            onSelect={() =>
              (workingDiff.viewMode = workingDiff.viewMode === 'unified' ? 'split' : 'unified')}
          >
            {#if workingDiff.viewMode === 'unified'}
              <Columns class="size-3" />
              <span>Split view</span>
            {:else}
              <Rows class="size-3" />
              <span>Unified view</span>
            {/if}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!activeCwd}
            onSelect={() => (workingDiff.wordWrap = !workingDiff.wordWrap)}
          >
            <WrapText class="size-3" />
            <span>{workingDiff.wordWrap ? 'No wrap' : 'Wrap lines'}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            disabled={!activeCwd || stackChanges.length === 0}
            onSelect={toggleAllCollapsed}
          >
            {#if allCollapsed}
              <UnfoldVertical class="size-3" />
              <span>Expand all</span>
            {:else}
              <FoldVertical class="size-3" />
              <span>Collapse all</span>
            {/if}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!activeCwd || changesEntry?.loading}
            onSelect={() => void refresh()}
          >
            {#if changesEntry?.loading}
              <Loader2 class="size-3 animate-spin" />
            {:else}
              <RefreshCw class="size-3" />
            {/if}
            <span>Refresh</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            disabled={!activeCwd || allWtChanges.length === 0}
            class="text-destructive focus:text-destructive"
            onSelect={() => void discardAll()}
          >
            <RotateCcw class="size-3" />
            <span>Discard all changes</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </header>

  {#if !activeCwd}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      Pick a session to inspect its working tree.
    </div>
  {:else if showComments}
    <RailCommentsPanel scope={activeReviewScope!} onClose={() => (showComments = false)} />
  {:else if changesEntry?.result && !changesEntry.result.isRepo}
    <div class="flex flex-1 items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
      <GitCompare class="size-4 shrink-0" />
      <span>This folder isn't a git repository.</span>
    </div>
  {:else}
    <div
      class="flex flex-col gap-1.5 border-b border-border px-3 py-2"
      class:hidden={diffExpanded}
    >
      <div class="relative">
        <Search class="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          bind:ref={searchInputEl}
          bind:value={queryDraft}
          oninput={commitQuery}
          placeholder="Filter by path"
          aria-label="Filter changes"
          class="h-7 pl-6 text-[11px]"
        />
      </div>
      <div class="flex items-center justify-between gap-1.5 text-[10px]">
        <div class="flex items-center gap-0.5">
          {#each filterOptions as opt (opt.id)}
            {@const active = workingDiff.filter === opt.id}
            <button
              type="button"
              class={[
                'rounded-md px-1.5 py-0.5 transition-colors',
                active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              ]}
              onclick={() => (workingDiff.filter = opt.id)}
              aria-pressed={active}
            >
              {opt.label}
            </button>
          {/each}
        </div>
        <div class="flex items-center gap-1.5">
          {#if activeCwd && !isRangeMode}
            <Popover.Root>
              <Popover.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    title="Commit, push, pull…"
                  >
                    <GitCommitIcon class="size-3" />
                    <span>Commit</span>
                  </button>
                {/snippet}
              </Popover.Trigger>
              <Popover.Content align="end" class="w-80 p-0">
                {#key activeReviewScope ? worktreeScopeKey(activeReviewScope) : activeCwd}
                  <CommitComposer scope={activeReviewScope!} />
                {/key}
              </Popover.Content>
            </Popover.Root>
          {/if}
          <label
            class="flex items-center gap-1 text-muted-foreground"
            title="Lines of unchanged context around each change"
          >
            <span>ctx</span>
            <input
              type="number"
              min="0"
              max="50"
              value={workingDiff.contextLines}
              oninput={(e) =>
                setContextLines(Number((e.currentTarget as HTMLInputElement).value))}
              class="h-5 w-9 rounded border border-input bg-transparent px-1 text-right font-mono text-[10px] outline-none focus:border-ring"
              aria-label="Context lines"
            />
          </label>
        </div>
      </div>
    </div>

    {#snippet wtChangeRow(change: WorkingChange)}
      <ChangeRow
        {change}
        selected={reviewEntryId(change, reviewMode) === effectiveSelected}
        pending={activeReviewScope ? workingDiff.isStagePending(activeReviewScope, change.path) : false}
        onpick={() => pickChange(change)}
        onstage={!change.staged ? () => void stageFile(change.path).catch(reportError) : undefined}
        onunstage={change.staged ? () => void unstageFile(change.path).catch(reportError) : undefined}
        ondiscard={() => void discardChange(change)}
      />
    {/snippet}
    {#snippet committedChangeRow(change: WorkingChange)}
      <div class="flex flex-col">
        <ChangeRow
          {change}
          selected={reviewEntryId(change, reviewMode) === effectiveSelected}
          onpick={() => pickChange(change)}
        />
        {#if change.commitsTouching && change.commitsTouching.length > 0}
          <div class="flex flex-wrap gap-1 px-2 pb-1 pl-8">
            {#each change.commitsTouching as sha (sha)}
              {@const short = sha.slice(0, 7)}
              {@const activeChip = reviewMode.kind === 'range' && reviewMode.chipFilter === sha}
              <button
                type="button"
                class={[
                  'rounded px-1 py-px font-mono text-[10px] transition-colors',
                  activeChip
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                ]}
                onclick={(e) => {
                  e.stopPropagation();
                  pickCommitChip(sha);
                }}
                title={activeChip ? 'Clear commit filter' : `Filter list to commit ${short}`}
              >
                {short}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/snippet}

    <ScrollArea
      class={['shrink-0', diffExpanded && 'hidden']}
      style="height: {listHeight}px"
    >
      <div class="flex flex-col gap-px p-1.5">
        {#if changesEntry?.loading && filteredChanges.length === 0}
          <div class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 class="size-3 animate-spin" />
            Loading…
          </div>
        {:else if changesEntry?.error}
          <div class="flex items-start gap-2 px-2 py-3 text-xs text-destructive">
            <AlertCircle class="size-3 shrink-0" />
            <span class="break-words">{changesEntry.error}</span>
          </div>
        {:else if filteredChanges.length === 0}
          <div class="px-2 py-3 text-xs text-muted-foreground">
            {#if totalChangeCount === 0}
              {#if isRangeMode}
                No files changed in this range.
              {:else}
                Working tree is clean.
              {/if}
            {:else}
              Nothing matches the current filter.
            {/if}
          </div>
        {:else if showRangeGroups}
          {#if renderedWtSectionChanges.length > 0}
            <div class="flex items-center justify-between px-2 pt-1.5 pb-0.5">
              <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Working tree ({wtSectionChanges.length})
              </span>
            </div>
            {#each renderedWtSectionChanges as change (change.path)}
              {@render wtChangeRow(change)}
            {/each}
          {/if}
          {#if renderedCommittedSectionChanges.length > 0}
            <div class="flex items-center justify-between px-2 pt-1.5 pb-0.5">
              <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Commits ({committedSectionChanges.length})
              </span>
            </div>
            {#each renderedCommittedSectionChanges as change (change.path)}
              {@render committedChangeRow(change)}
            {/each}
          {/if}
        {:else if showWtModeGroups}
          {#if renderedStagedChanges.length > 0}
            <div class="flex items-center justify-between px-2 pt-1.5 pb-0.5">
              <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Staged ({stagedChanges.length})
              </span>
              <button
                type="button"
                class="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
                onclick={() => void unstageAll().catch(reportError)}
                title="Unstage all"
                aria-label="Unstage all"
              >
                <Minus class="size-3" />
              </button>
            </div>
            {#each renderedStagedChanges as change (change.path)}
              {@render wtChangeRow(change)}
            {/each}
          {/if}
          {#if renderedUnstagedChanges.length > 0}
            <div class="flex items-center justify-between px-2 pt-1.5 pb-0.5">
              <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Changes ({unstagedChanges.length})
              </span>
              <button
                type="button"
                class="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
                onclick={() => void stageAll().catch(reportError)}
                title="Stage all"
                aria-label="Stage all"
              >
                <Plus class="size-3" />
              </button>
            </div>
            {#each renderedUnstagedChanges as change (change.path)}
              {@render wtChangeRow(change)}
            {/each}
          {/if}
        {:else}
          {#each renderedStackChanges as change (change.path)}
            {@render wtChangeRow(change)}
          {/each}
        {/if}
      </div>
    </ScrollArea>
    {#if renderingChanges}
      <div
        class="shrink-0 border-b border-border px-2 py-1 text-[10px] text-muted-foreground"
        aria-live="polite"
      >
        Rendering {renderedChangeCount} of {stackChanges.length} files…
      </div>
    {/if}
    <button
      type="button"
      class={[
        'h-1.5 w-full shrink-0 cursor-row-resize border-b border-border outline-none transition-colors hover:bg-ring/30 focus-visible:bg-ring/40',
        resizingList && 'bg-ring/20',
        diffExpanded && 'hidden'
      ]}
      aria-label="Resize file list"
      onpointerdown={startResizeList}
    ></button>

    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      {#if stackChanges.length === 0}
        <div class="flex flex-1 items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
          <FileDiff class="size-4 shrink-0" />
          <span>Nothing to diff.</span>
        </div>
      {:else}
        <ScrollArea
          orientation={workingDiff.wordWrap ? 'vertical' : 'both'}
          class="min-h-0 flex-1"
          bind:viewportRef={diffViewportEl}
        >
          <div
            bind:this={diffRootEl}
            class="flex flex-col"
            style:overflow-anchor="none"
          >
            {#each renderedStackChanges as change (reviewEntryId(change, reviewMode))}
              {@const entryId = reviewEntryId(change, reviewMode)}
              {@const isCommitted = change.section === 'committed'}
              {@const rangeBase = isCommitted && reviewMode.kind === 'range' ? reviewMode.base : null}
              {@const rangeHead = isCommitted && reviewMode.kind === 'range' ? reviewMode.head : null}
              {@const entry = workingDiff.diffEntryFor(activeReviewScope!, change.path, rangeBase, rangeHead)}
              {@const fileDiff = entry?.diff ?? null}
              {@const gapPath = fileDiff?.fromPath ?? change.path}
              {@const gapRevision = isCommitted && reviewMode.kind === 'range'
                ? reviewMode.base
                : 'HEAD'}
              {@const canExpand = fileDiff
                ? fileDiff.kind !== 'added' && fileDiff.kind !== 'untracked'
                : false}
              {@const gutter = gutterWidthFor(fileDiff?.hunks)}
              {@const isActive = entryId === effectiveSelected}
              {@const collapsed = isCollapsed(change)}
              {@const resident = residentEntries.has(entryId)}
              {@const retainedBodyHeight = reviewViewport.retainedBodyHeight(
                entryId,
                estimateReviewBodyHeight(
                  fileDiff,
                  settings.current.diff.fontSize,
                  workingDiff.wordWrap
                )
              )}
              {@const stagePending = activeReviewScope ? workingDiff.isStagePending(activeReviewScope, change.path) : false}
              <div
                use:bindSection={entryId}
                data-file-path={change.path}
                data-diff-file-path={fileDiff?.path ?? change.path}
                data-review-entry={entryId}
                class="relative flex flex-col"
              >
                <header
                  role="button"
                  tabindex="0"
                  class={[
                    'sticky top-0 z-20 flex cursor-pointer items-center gap-2 border-y border-border px-3 py-1.5 backdrop-blur-sm select-none',
                    isActive ? 'bg-muted/90' : 'bg-background/95'
                  ]}
                  onclick={() => toggleCollapsed(change)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleCollapsed(change);
                    }
                  }}
                  aria-expanded={!collapsed}
                  aria-label={collapsed ? `Expand ${change.path}` : `Collapse ${change.path}`}
                  title={collapsed ? 'Expand' : 'Collapse'}
                >
                  <span
                    class="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/80"
                    aria-hidden="true"
                  >
                    {#if collapsed}
                      <ChevronRight class="size-3" />
                    {:else}
                      <ChevronDown class="size-3" />
                    {/if}
                  </span>
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-mono text-[11px] text-foreground">
                      {fileDiff?.path ?? change.path}
                    </span>
                    {#if fileDiff?.fromPath && fileDiff.fromPath !== fileDiff.path}
                      <span class="truncate text-[10px] text-muted-foreground">
                        from {fileDiff.fromPath}
                      </span>
                    {/if}
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <span class="font-mono text-[10px] text-muted-foreground uppercase">
                      {fileDiff?.kind ?? change.kind}
                    </span>
                    {#if !isCommitted}
                      <button
                        type="button"
                        class="flex size-4 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted-foreground/20 hover:text-rose-500"
                        onclick={(e) => {
                          e.stopPropagation();
                          void discardChange(change);
                        }}
                        title="Discard changes"
                        aria-label="Discard changes to {change.path}"
                      >
                        <RotateCcw class="size-3" />
                      </button>
                      {#if change.staged}
                        <button
                          type="button"
                          class="flex size-4 items-center justify-center rounded text-rose-500/70 transition-colors hover:bg-muted-foreground/20 hover:text-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
                          onclick={(e) => {
                            e.stopPropagation();
                            void unstageFile(change.path).catch(reportError);
                          }}
                          disabled={stagePending}
                          title="Unstage"
                          aria-label="Unstage {change.path}"
                        >
                          {#if stagePending}
                            <Loader2 class="size-3 animate-spin" />
                          {:else}
                            <Minus class="size-3" />
                          {/if}
                        </button>
                      {:else}
                        <button
                          type="button"
                          class="flex size-4 items-center justify-center rounded text-emerald-500/70 transition-colors hover:bg-muted-foreground/20 hover:text-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                          onclick={(e) => {
                            e.stopPropagation();
                            void stageFile(change.path).catch(reportError);
                          }}
                          disabled={stagePending}
                          title="Stage"
                          aria-label="Stage {change.path}"
                        >
                          {#if stagePending}
                            <Loader2 class="size-3 animate-spin" />
                          {:else}
                            <Plus class="size-3" />
                          {/if}
                        </button>
                      {/if}
                    {/if}
                  </div>
                </header>
                <div
                  use:bindBodyWrapper={entryId}
                  style:height={!collapsed && !resident ? `${retainedBodyHeight}px` : null}
                  aria-hidden={!collapsed && !resident ? 'true' : null}
                >
                  {#if !collapsed && resident}
                    {#if entry?.loading && !fileDiff}
                      <DiffLoadPlaceholder loading={true} error={null} onLoad={() => loadReviewDiff(change)} />
                    {:else if entry?.error}
                      <DiffLoadPlaceholder loading={false} error={entry.error} onLoad={() => loadReviewDiff(change)} />
                    {:else if fileDiff?.binary}
                      <div class="px-3 py-4 text-center text-xs text-muted-foreground">
                        Binary file — diff not shown.
                      </div>
                    {:else if fileDiff && (fileDiff.empty || fileDiff.hunks.length === 0)}
                      <div class="px-3 py-4 text-center text-xs text-muted-foreground">
                        No textual changes.
                      </div>
                    {:else if fileDiff}
                      <VirtualDiffBody
                        scope={activeReviewScope!}
                        filePath={fileDiff.path}
                        {gapPath}
                        {gapRevision}
                        reviewSection={reviewEntrySection(change)}
                        diff={fileDiff}
                        mode={compactViewport ? 'unified' : workingDiff.viewMode}
                        gutterWidth={gutter}
                        {canExpand}
                        wrap={workingDiff.wordWrap}
                        viewport={diffViewportEl}
                        viewportScrollTop={reviewViewport.scrollTop}
                        viewportHeight={reviewViewport.height}
                        viewportVersion={reviewViewport.scrollVersion}
                        sectionTop={sectionTops[entryId] ?? 0}
                      />
                    {:else}
                      <DiffLoadPlaceholder loading={false} error={null} onLoad={() => loadReviewDiff(change)} />
                    {/if}
                  {/if}
                </div>
              </div>
            {/each}
            <DiffSelectionMenu
              rootEl={diffRootEl}
              active={selectionMenuActive}
              contextKey={selectionContextKey}
              geometryVersion={selectionGeometryVersion}
              resolveTarget={selectionTargetForEntry}
            />
          </div>
        </ScrollArea>
      {/if}
    </section>
  {/if}
</div>
