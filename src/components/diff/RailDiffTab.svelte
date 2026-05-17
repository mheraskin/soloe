<script lang="ts">
  import {
    GitCompare,
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
    WrapText,
    MessageSquare,
    ChevronsUp,
    ChevronsDown,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    RotateCcw,
    FoldVertical,
    UnfoldVertical
  } from '@lucide/svelte';
  import { onMount, untrack } from 'svelte';
  import type { DiffHunk } from '@shared/types/git.js';
  import { sessions } from '../../stores/sessions.svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import { confirmStore } from '../../stores/confirm.svelte';
  import type { WorkingChange } from '@shared/types/git.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import ChangeRow from './ChangeRow.svelte';
  import VirtualDiffBody from './VirtualDiffBody.svelte';
  import RailCommentsPanel from './RailCommentsPanel.svelte';
  import DiffSelectionMenu from './DiffSelectionMenu.svelte';

  let diffRootEl: HTMLDivElement | null = $state(null);
  let diffViewportEl: HTMLElement | null = $state(null);

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
  let userListHeightOverride = $state<number | null>(null);
  let resizingList = $state(false);
  let resizeStartY = 0;
  let resizeStartHeight = 0;
  let diffExpanded = $state(false);

  type FilterValue = 'all' | 'staged' | 'unstaged' | 'untracked';

  const filterOptions: ReadonlyArray<{ id: FilterValue; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'staged', label: 'Staged' },
    { id: 'unstaged', label: 'Unstaged' },
    { id: 'untracked', label: 'New' }
  ];

  let selected = $derived(sessions.selected);

  // The worktree cwd anchors every store key. We register run-mode + WSL distro
  // so the IPC layer can dispatch to native or WSL git as appropriate.
  let activeCwd = $derived.by<string | null>(() => {
    const cwd = selected?.cwd?.trim();
    return cwd && cwd.length > 0 ? cwd : null;
  });

  $effect(() => {
    if (!activeCwd || !selected) return;
    workingDiff.setContext(activeCwd, {
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    });
  });

  // Auto-load changes whenever the active worktree changes. Subsequent refreshes
  // are pushed by the git change listener attached on mount.
  $effect(() => {
    const cwd = activeCwd;
    if (!cwd) return;
    void workingDiff
      .loadChanges(cwd)
      .then((result) => {
        // Kick off the eager prefetch as soon as the file list lands. Each
        // diff request is deduped against the in-flight selection click so
        // there's no race penalty for the file the user picks first.
        if (result) void workingDiff.prefetchDiffs(cwd);
      })
      .catch(reportError);
  });

  // Whenever the user changes the context-lines slider, every diff entry is
  // wiped. Re-prime the cache so subsequent clicks stay instant — the active
  // file is already being refetched by the selection effect below.
  $effect(() => {
    const cwd = activeCwd;
    workingDiff.contextLines;
    if (!cwd) return;
    if (!workingDiff.changesFor(cwd).result) return;
    void workingDiff.prefetchDiffs(cwd);
  });

  let changesEntry = $derived(activeCwd ? workingDiff.changesFor(activeCwd) : null);
  let filteredChanges = $derived(activeCwd ? workingDiff.filteredChangesFor(activeCwd) : []);
  let totalChangeCount = $derived(changesEntry?.result?.changes.length ?? 0);
  let stagedChanges = $derived(filteredChanges.filter((c) => c.staged));
  let unstagedChanges = $derived(filteredChanges.filter((c) => !c.staged));
  let showGroups = $derived(workingDiff.filter === 'all' && (stagedChanges.length > 0 || unstagedChanges.length > 0));
  // Stack order mirrors the file list under the "All" filter (staged then
  // unstaged) so clicking a row scrolls to the same index in the diff.
  let stackChanges = $derived(showGroups ? [...stagedChanges, ...unstagedChanges] : filteredChanges);

  let storedSelected = $derived(activeCwd ? workingDiff.selectedFilePath(activeCwd) : null);
  // Multi-file viewer renders the filtered set as a scroll stack; the
  // "selected" file is the one currently in view (highlight + active for
  // outside integrations). Anything outside the filter can't be the active
  // one because it isn't rendered.
  let effectiveSelected = $derived.by<string | null>(() => {
    if (storedSelected && filteredChanges.some((c) => c.path === storedSelected)) {
      return storedSelected;
    }
    if (!filteredChanges.length) return null;
    return filteredChanges[0]?.path ?? null;
  });

  $effect(() => {
    if (!activeCwd) return;
    const next = effectiveSelected;
    if (next && next !== storedSelected) {
      workingDiff.setSelected(activeCwd, next);
    }
  });

  $effect(() => {
    const cwd = activeCwd;
    const path = effectiveSelected;
    if (!cwd || !path) {
      if (cwd) workingDiff.setActive({ cwd, filePath: '' });
      return;
    }
    workingDiff.setActive({ cwd, filePath: path });
    void workingDiff.loadDiff(cwd, path).catch(reportError);
  });

  // Per-file refs power the scroll-stacked viewer: each file section reports
  // its position so virtualization stays correct and click-to-scroll lands on
  // the right anchor. Actions register/unregister and bump layoutTick so the
  // sectionTops derived recomputes — ResizeObserver covers the rest.
  let sectionEls = $state<Record<string, HTMLDivElement | null>>({});
  let bodyWrapperEls = $state<Record<string, HTMLDivElement | null>>({});
  let layoutTick = $state(0);

  function bindSection(node: HTMLDivElement, path: string) {
    sectionEls[path] = node;
    layoutTick++;
    let current = path;
    return {
      update(newPath: string) {
        if (newPath === current) return;
        sectionEls[current] = null;
        current = newPath;
        sectionEls[current] = node;
        layoutTick++;
      },
      destroy() {
        sectionEls[current] = null;
        layoutTick++;
      }
    };
  }

  function bindBodyWrapper(node: HTMLDivElement, path: string) {
    bodyWrapperEls[path] = node;
    layoutTick++;
    let current = path;
    return {
      update(newPath: string) {
        if (newPath === current) return;
        bodyWrapperEls[current] = null;
        current = newPath;
        bodyWrapperEls[current] = node;
        layoutTick++;
      },
      destroy() {
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

  $effect(() => {
    const root = diffRootEl;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      layoutTick++;
    });
    ro.observe(root);
    return () => ro.disconnect();
  });

  // Body offsets within diffRootEl. VirtualDiffBody virtualizes against the
  // shared viewport scrollTop; without these offsets every body would think
  // its content starts at scroll 0 and stickies/visible-rows would misalign.
  let sectionTops = $derived.by<Record<string, number>>(() => {
    void layoutTick;
    const out: Record<string, number> = {};
    const root = diffRootEl;
    if (!root) return out;
    const rootRect = root.getBoundingClientRect();
    for (const change of stackChanges) {
      const wrapper = bodyWrapperEls[change.path];
      if (!wrapper) continue;
      out[change.path] = wrapper.getBoundingClientRect().top - rootRect.top;
    }
    return out;
  });

  // Per-file collapse state. Keyed by `${cwd}::${path}` so it stays stable
  // across worktree switches without spilling between them. Staged files are
  // auto-seeded collapsed (see effect below) so a big mechanical staged diff
  // doesn't drown out the unstaged review; once the user toggles, their
  // preference wins for the rest of the session.
  let collapsedByPath = $state<Record<string, boolean>>({});
  // Plain Set: non-reactive memory of which (cwd,path) pairs have already
  // been considered for the staged-seed rule. Stays out of the dependency
  // graph so the seeding effect below doesn't read what it writes.
  const collapseSeedSeen = new Set<string>();

  function collapseKey(path: string): string {
    return `${activeCwd ?? '__none__'}::${path}`;
  }

  function isCollapsed(change: WorkingChange): boolean {
    return collapsedByPath[collapseKey(change.path)] === true;
  }

  function toggleCollapsed(change: WorkingChange): void {
    const key = collapseKey(change.path);
    const next = { ...collapsedByPath };
    if (next[key]) delete next[key];
    else next[key] = true;
    collapsedByPath = next;
  }

  let allCollapsed = $derived.by<boolean>(() => {
    if (stackChanges.length === 0) return false;
    return stackChanges.every((c) => collapsedByPath[collapseKey(c.path)] === true);
  });

  function toggleAllCollapsed(): void {
    const target = !allCollapsed;
    const next = { ...collapsedByPath };
    for (const c of stackChanges) {
      const key = collapseKey(c.path);
      if (target) next[key] = true;
      else delete next[key];
    }
    collapsedByPath = next;
  }

  // Staged-file auto-collapse seed. The `untrack` here keeps us from
  // subscribing to our own write of `collapsedByPath` — `{...collapsedByPath}`
  // would otherwise re-trigger this effect under Svelte 5 prod cycle
  // detection (same self-loop pattern as `layoutTick++`).
  $effect(() => {
    if (!activeCwd) return;
    let pending: string[] | null = null;
    for (const change of stackChanges) {
      if (!change.staged) continue;
      const key = collapseKey(change.path);
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
    const cwd = activeCwd;
    if (!cwd) return;
    for (const change of filteredChanges) {
      const entry = workingDiff.diffEntryFor(cwd, change.path);
      if (entry?.diff) {
        diffComments.recomputeOutdated(cwd, change.path, entry.diff);
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

  let queryDraft = $state(workingDiff.query);

  function commitQuery(): void {
    workingDiff.query = queryDraft;
  }

  // The single Comments rail consolidates Active/Outdated/Resolved tabs and
  // owns the per-comment Send affordances; this tab just toggles it open.
  // The toggle's count reflects unresolved threads only — resolved ones are
  // still reachable inside the panel but stay out of the headline number.
  let totalCommentCount = $derived(
    activeCwd
      ? diffComments.forWorktree(activeCwd).filter((c) => !c.resolvedAt).length
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
    const headerCount = showGroups
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

  function pickChange(path: string): void {
    if (!activeCwd) return;
    workingDiff.setSelected(activeCwd, path);
    // Expand the picked file so the click actually reveals content rather
    // than scrolling to a still-collapsed header.
    const key = collapseKey(path);
    if (collapsedByPath[key]) {
      const next = { ...collapsedByPath };
      delete next[key];
      collapsedByPath = next;
    }
    const section = sectionEls[path];
    const viewport = diffViewportEl;
    if (!section || !viewport) return;
    const sectionRect = section.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const top = viewport.scrollTop + sectionRect.top - viewportRect.top;
    viewport.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  async function stageFile(path: string): Promise<void> {
    if (!activeCwd) return;
    await workingDiff.stageFiles(activeCwd, [path]);
  }

  async function unstageFile(path: string): Promise<void> {
    if (!activeCwd) return;
    await workingDiff.unstageFiles(activeCwd, [path]);
  }

  async function stageAll(): Promise<void> {
    if (!activeCwd) return;
    const paths = unstagedChanges.map((c) => c.path);
    if (paths.length) await workingDiff.stageFiles(activeCwd, paths);
  }

  async function unstageAll(): Promise<void> {
    if (!activeCwd) return;
    const paths = stagedChanges.map((c) => c.path);
    if (paths.length) await workingDiff.unstageFiles(activeCwd, paths);
  }

  // Destructive: discarding rewrites the working tree from HEAD (or removes
  // untracked/added files outright). Always gate on a danger confirm — this
  // is the same pattern other delete-style flows use.
  async function discardChange(change: WorkingChange): Promise<void> {
    if (!activeCwd) return;
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
      await workingDiff.discardFiles(activeCwd, [change]);
    } catch (err) {
      reportError(err);
    }
  }

  async function refresh(): Promise<void> {
    if (!activeCwd) return;
    workingDiff.invalidate(activeCwd);
    try {
      const result = await workingDiff.loadChanges(activeCwd);
      if (result) void workingDiff.prefetchDiffs(activeCwd);
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
    const v = diffViewportEl;
    if (!cwd || !v) return;
    const onScroll = () => {
      // User input wins — abort any pending restore so we don't clobber it.
      if (restoreTimer !== null) cancelRestore();
      if (scrollSaveTimer !== null) clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => {
        scrollSaveTimer = null;
        rightRail.setDiffScrollTop(cwd, v.scrollTop);
      }, SCROLL_SAVE_DEBOUNCE_MS);
    };
    v.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      v.removeEventListener('scroll', onScroll);
      if (scrollSaveTimer !== null) {
        clearTimeout(scrollSaveTimer);
        scrollSaveTimer = null;
      }
    };
  });

  onMount(() => {
    const raw = localStorage.getItem(LIST_HEIGHT_KEY);
    if (raw !== null) {
      const stored = Number(raw);
      if (Number.isFinite(stored) && stored > 0) {
        userListHeightOverride = clampListHeight(stored);
      }
    }
    workingDiff.attachListeners();
    const onRefocus = () => {
      if (rightRail.activeTab !== 'diff') return;
      searchInputEl?.focus();
      searchInputEl?.select();
    };
    window.addEventListener('soloe:refocus-rail', onRefocus);
    // Single document-level mouseup finalizes any in-progress gutter drag
    // started inside a HunkBlock. Without this, releasing the cursor outside
    // a gutter cell would leave the selection stuck in dragging state.
    // Use the selection's own file rather than the active one — drag may
    // have started in a file that isn't the topmost in the viewport.
    const onDocMouseup = () => {
      const sel = diffComments.selection;
      if (!sel?.dragging) return;
      const cwd = activeCwd;
      if (!cwd) return;
      const entry = workingDiff.diffEntryFor(cwd, sel.filePath);
      diffComments.endSelectionAndCreate(entry?.diff ?? null);
    };
    window.addEventListener('mouseup', onDocMouseup);
    return () => {
      window.removeEventListener('soloe:refocus-rail', onRefocus);
      window.removeEventListener('mouseup', onDocMouseup);
      workingDiff.detach();
    };
  });
</script>

<div class="flex min-h-0 flex-1 flex-col" class:select-none={resizingList}>
  <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
    <div class="flex min-w-0 flex-col" class:hidden={diffExpanded}>
      <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        Working tree
      </span>
      <span class="truncate text-xs text-foreground">
        {selected ? selected.name : 'No session selected'}
      </span>
    </div>
    <div class="flex items-center gap-1" class:ml-auto={diffExpanded}>
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
      <Button
        variant="ghost"
        size="xs"
        onclick={() => (workingDiff.wordWrap = !workingDiff.wordWrap)}
        aria-label={workingDiff.wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
        title={workingDiff.wordWrap ? 'No wrap' : 'Wrap lines'}
        aria-pressed={workingDiff.wordWrap}
        disabled={!activeCwd}
      >
        <WrapText class="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onclick={() =>
          (workingDiff.viewMode = workingDiff.viewMode === 'unified' ? 'split' : 'unified')}
        aria-label={workingDiff.viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view'}
        title={workingDiff.viewMode === 'unified' ? 'Split view' : 'Unified view'}
        disabled={!activeCwd}
      >
        {#if workingDiff.viewMode === 'unified'}
          <Columns class="size-3" />
        {:else}
          <Rows class="size-3" />
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onclick={toggleAllCollapsed}
        aria-pressed={allCollapsed}
        aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
        title={allCollapsed ? 'Expand all' : 'Collapse all'}
        disabled={!activeCwd || stackChanges.length === 0}
      >
        {#if allCollapsed}
          <UnfoldVertical class="size-3" />
        {:else}
          <FoldVertical class="size-3" />
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onclick={() => (diffExpanded = !diffExpanded)}
        aria-pressed={diffExpanded}
        aria-label={diffExpanded ? 'Show file list' : 'Hide file list'}
        title={diffExpanded ? 'Show file list' : 'Hide file list'}
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
      <Button
        variant="ghost"
        size="xs"
        onclick={() => void refresh()}
        aria-label="Refresh changes"
        title="Refresh"
        disabled={!activeCwd || changesEntry?.loading}
      >
        {#if changesEntry?.loading}
          <Loader2 class="size-3 animate-spin" />
        {:else}
          <RefreshCw class="size-3" />
        {/if}
      </Button>
    </div>
  </header>

  {#if !activeCwd}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      Pick a session to inspect its working tree.
    </div>
  {:else if showComments}
    <RailCommentsPanel cwd={activeCwd} onClose={() => (showComments = false)} />
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
          class="h-7 pl-6 text-xs"
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
              Working tree is clean.
            {:else}
              Nothing matches the current filter.
            {/if}
          </div>
        {:else if showGroups}
          {#if stagedChanges.length > 0}
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
            {#each stagedChanges as change (change.path)}
              <ChangeRow
                {change}
                selected={change.path === effectiveSelected}
                pending={activeCwd ? workingDiff.isStagePending(activeCwd, change.path) : false}
                onpick={() => pickChange(change.path)}
                onunstage={() => void unstageFile(change.path).catch(reportError)}
                ondiscard={() => void discardChange(change)}
              />
            {/each}
          {/if}
          {#if unstagedChanges.length > 0}
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
            {#each unstagedChanges as change (change.path)}
              <ChangeRow
                {change}
                selected={change.path === effectiveSelected}
                pending={activeCwd ? workingDiff.isStagePending(activeCwd, change.path) : false}
                onpick={() => pickChange(change.path)}
                onstage={() => void stageFile(change.path).catch(reportError)}
                ondiscard={() => void discardChange(change)}
              />
            {/each}
          {/if}
        {:else}
          {#each filteredChanges as change (change.path)}
            <ChangeRow
              {change}
              selected={change.path === effectiveSelected}
              pending={activeCwd ? workingDiff.isStagePending(activeCwd, change.path) : false}
              onpick={() => pickChange(change.path)}
              onstage={!change.staged ? () => void stageFile(change.path).catch(reportError) : undefined}
              onunstage={change.staged ? () => void unstageFile(change.path).catch(reportError) : undefined}
              ondiscard={() => void discardChange(change)}
            />
          {/each}
        {/if}
      </div>
    </ScrollArea>
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

    <section class="flex min-h-0 flex-1 flex-col">
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
            {#each stackChanges as change (change.path)}
              {@const entry = workingDiff.diffEntryFor(activeCwd!, change.path)}
              {@const fileDiff = entry?.diff ?? null}
              {@const gapPath = fileDiff?.fromPath ?? change.path}
              {@const canExpand = fileDiff ? fileDiff.kind !== 'added' && fileDiff.kind !== 'untracked' : false}
              {@const gutter = gutterWidthFor(fileDiff?.hunks)}
              {@const isActive = change.path === effectiveSelected}
              {@const collapsed = isCollapsed(change)}
              {@const stagePending = activeCwd ? workingDiff.isStagePending(activeCwd, change.path) : false}
              <div
                use:bindSection={change.path}
                data-file-path={change.path}
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
                  </div>
                </header>
                <div use:bindBodyWrapper={change.path}>
                  {#if !collapsed}
                    {#if entry?.loading && !fileDiff}
                      <div class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                        <Loader2 class="size-3 animate-spin" />
                        Loading diff…
                      </div>
                    {:else if entry?.error}
                      <div class="flex items-start justify-center gap-2 px-3 py-4 text-xs text-destructive">
                        <AlertCircle class="size-3 shrink-0" />
                        <span class="break-words">{entry.error}</span>
                      </div>
                    {:else if fileDiff?.binary}
                      <div class="px-3 py-4 text-center text-xs text-muted-foreground">
                        Binary file — diff not shown.
                      </div>
                    {:else if fileDiff && (fileDiff.empty || fileDiff.hunks.length === 0)}
                      <div class="px-3 py-4 text-center text-xs text-muted-foreground">
                        No textual changes.
                      </div>
                    {:else if fileDiff}
                      <DiffSelectionMenu
                        cwd={activeCwd!}
                        filePath={fileDiff.path}
                        rootEl={sectionEls[change.path]}
                        diff={fileDiff}
                      />
                      <VirtualDiffBody
                        cwd={activeCwd!}
                        filePath={fileDiff.path}
                        {gapPath}
                        diff={fileDiff}
                        mode={workingDiff.viewMode}
                        gutterWidth={gutter}
                        {canExpand}
                        wrap={workingDiff.wordWrap}
                        viewport={diffViewportEl}
                        sectionTop={sectionTops[change.path] ?? 0}
                      />
                    {:else}
                      <div class="px-3 py-6 text-center text-xs text-muted-foreground">
                        Diff not loaded.
                      </div>
                    {/if}
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </ScrollArea>
      {/if}
    </section>
  {/if}
</div>
