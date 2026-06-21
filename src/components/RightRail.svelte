<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Activity,
    NotebookPen,
    GitCompare,
    ArrowLeftRight,
    FolderTree,
    Microscope,
    Globe
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { rightRail, type RailTabId } from '../stores/right-rail.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { sidebar } from '../stores/sidebar.svelte';
  import { featuresStore } from '../stores/features.svelte';
  import { Keymap } from '../lib/keymap';
  import { toggleRailTabAndFocus } from '../lib/rail-focus';
  import { clampSplitRatio, splitPaneWidths, type RailSize } from '../lib/rail-widths';
  import { kbdHints } from '../stores/kbd-hints.svelte';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Kbd } from '$lib/components/ui/kbd';
  import ProcessUsageWidget from './ProcessUsageWidget.svelte';
  import RailInspectorTab from './rail/RailInspectorTab.svelte';
  import RailNotesTab from './rail/RailNotesTab.svelte';
  import RailDiffTab from './diff/RailDiffTab.svelte';
  import RailFilesTab from './files/RailFilesTab.svelte';
  import RailFeatureTab from './feature/RailFeatureTab.svelte';
  import RailBrowserTab from './rail/RailBrowserTab.svelte';

  interface Tab {
    id: RailTabId;
    label: string;
    icon: Component<any, {}, ''>;
    shortcut?: readonly string[];
  }

  const tabs: Tab[] = [
    { id: 'inspector', label: 'Inspector', icon: Activity },
    { id: 'diff', label: 'Working diff', icon: GitCompare, shortcut: Keymap.toggleDiffRail.keys },
    { id: 'files', label: 'Files', icon: FolderTree, shortcut: Keymap.toggleFilesRail.keys },
    { id: 'feature', label: 'Feature Lab', icon: Microscope, shortcut: Keymap.toggleFeatureRail.keys },
    { id: 'browser', label: 'Browser', icon: Globe, shortcut: Keymap.toggleBrowserRail.keys },
    { id: 'notes', label: 'Notes', icon: NotebookPen, shortcut: Keymap.toggleNotesRail.keys }
  ];

  // The rail tracks one content width plus a split ratio. A single pane fills
  // railWidth; two panes divide it by splitRatio (slot 0 = left), defaulting to
  // an even split. Sizing math lives in src/lib/rail-widths.ts so the drag
  // handlers and render path agree.
  const SIZE_KEY = 'soloe.rail.size.v1';
  const ICON_COL_WIDTH = 40;
  const MIN_PANE_WIDTH = 220;
  const TERMINAL_MIN_WIDTH = 220;
  const FALLBACK_RAIL_WIDTH = 480;
  const SPLITTER = 4;
  const DEFAULT_RAIL_RATIO = 0.4;

  function computeDefaultSize(): RailSize {
    const railWidth =
      typeof window === 'undefined'
        ? FALLBACK_RAIL_WIDTH
        : Math.max(MIN_PANE_WIDTH, Math.round(window.innerWidth * DEFAULT_RAIL_RATIO));
    return { railWidth, splitRatio: 0.5 };
  }

  function loadSize(): RailSize {
    const fallback = computeDefaultSize();
    if (typeof localStorage === 'undefined') return fallback;
    try {
      const raw = localStorage.getItem(SIZE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<RailSize>;
      const railWidth =
        typeof parsed.railWidth === 'number' && Number.isFinite(parsed.railWidth)
          ? Math.max(MIN_PANE_WIDTH, Math.round(parsed.railWidth))
          : fallback.railWidth;
      const splitRatio =
        typeof parsed.splitRatio === 'number' ? clampSplitRatio(parsed.splitRatio) : 0.5;
      return { railWidth, splitRatio };
    } catch {
      return fallback;
    }
  }

  interface Props {
    // True when the active rail pane fills the entire main area (terminal
    // hidden). Suppresses the outer resize handle and the splitter.
    fullscreen?: boolean;
  }

  let { fullscreen = false }: Props = $props();

  let size = $state<RailSize>(computeDefaultSize());
  let resizing: 'outer' | 'splitter' | null = $state(null);
  let asideEl: HTMLElement | null = $state(null);

  // Mount-keep-alive lookups. Diff and Files persist their state across
  // worktree hops as long as some worktree has them open. Other tabs are
  // mounted only while they're visible in the current worktree.
  let diffMountedCwds = $derived(rightRail.diffMountedCwds);
  let filesMountedCwds = $derived(rightRail.filesMountedCwds);
  let diffMounted = $derived(diffMountedCwds.length > 0);
  let filesMounted = $derived(filesMountedCwds.length > 0);

  let openTabs = $derived(rightRail.openTabs);
  let railOpen = $derived(openTabs.length > 0);
  let fullscreenTab = $derived(rightRail.fullscreenTab);
  let twoPane = $derived(openTabs.length === 2);

  // Per-pane widths derived from the single rail width + split ratio. One pane
  // fills railWidth; two panes split it (50/50 by default — the drag handler
  // adjusts the ratio). splitPaneWidths enforces the per-pane minimum and the
  // splitter gap.
  let paneWidths = $derived.by<[number, number]>(() => {
    if (openTabs.length < 2) return [size.railWidth, MIN_PANE_WIDTH];
    return splitPaneWidths(size.railWidth, size.splitRatio, MIN_PANE_WIDTH, SPLITTER);
  });

  // Slot lookup: which position (0 = left, 1 = right) a tab occupies in
  // the current worktree, or null if it isn't open here. Position 0 is
  // the older click (leftmost), 1 is the newer (next to the icons).
  function slotOf(id: RailTabId): 0 | 1 | null {
    const idx = openTabs.indexOf(id);
    if (idx === -1) return null;
    return idx as 0 | 1;
  }

  function tabVisible(id: RailTabId): boolean {
    if (!railOpen) return false;
    if (fullscreen) return fullscreenTab === id;
    return openTabs.includes(id);
  }

  // Browser/feature don't keep-alive — see right-rail.svelte.ts.
  let featureMountedHere = $derived(tabVisible('feature'));
  let browserMountedHere = $derived(tabVisible('browser'));
  let inspectorMountedHere = $derived(tabVisible('inspector'));
  let notesMountedHere = $derived(tabVisible('notes'));

  let activeCwd = $derived.by<string | null>(() => {
    const cwd = sessions.selected?.cwd?.trim();
    return cwd && cwd.length > 0 ? cwd : null;
  });
  let featureNeedsSetup = $derived.by<boolean>(() => {
    if (!activeCwd) return false;
    const snap = featuresStore.stateFor(activeCwd)?.snapshot;
    return snap ? !snap.setup.hasAgentSkillsBlock : false;
  });

  // How much horizontal space the rail's content area gets to fill.
  // Single-pane uses paneWidths[0] only. Two-pane uses both. Fullscreen
  // ignores the persisted widths and stretches to fill the main area.
  let contentWidth = $derived(
    fullscreen
      ? 0
      : openTabs.length === 0
        ? 0
        : openTabs.length === 1
          ? paneWidths[0]
          : paneWidths[0] + paneWidths[1] + SPLITTER
  );
  let asideWidth = $derived(contentWidth + ICON_COL_WIDTH);

  onMount(() => {
    size = loadSize();
  });

  function persistSize(): void {
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    } catch {
      // Quota — ignore.
    }
  }

  function maxContentWidth(): number {
    const sidebarW = sidebar.effectiveWidth;
    return Math.max(MIN_PANE_WIDTH, window.innerWidth - sidebarW - TERMINAL_MIN_WIDTH - ICON_COL_WIDTH);
  }

  function clampTotal(target: number, paneCount: number): number {
    const splitter = paneCount === 2 ? SPLITTER : 0;
    const minTotal = paneCount === 2 ? MIN_PANE_WIDTH * 2 + splitter : MIN_PANE_WIDTH;
    return Math.max(minTotal, Math.min(maxContentWidth(), Math.round(target)));
  }

  // Pointer capture keeps drag events flowing to the handle even when the
  // cursor crosses a <webview> (events would otherwise be eaten by the
  // guest page). The window-level listeners still fire because captured
  // events bubble. The matching `soloe:rail-resize-*` window events tell
  // the browser tab to suspend its DevTools WebContentsView, which is a
  // native overlay that pointer capture *can't* reach.
  function startOuterResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = 'outer';
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    window.dispatchEvent(new CustomEvent('soloe:rail-resize-start'));
    window.addEventListener('pointermove', onOuterResize);
    window.addEventListener('pointerup', stopOuterResize, { once: true });
  }

  function onOuterResize(event: PointerEvent) {
    // Outer handle sits at the rail's left edge; dragging left grows the rail.
    // Total content = window - clientX - icon column. The split ratio is left
    // untouched so both panes scale together.
    const targetContent = window.innerWidth - event.clientX - ICON_COL_WIDTH;
    const paneCount = openTabs.length >= 2 ? 2 : 1;
    size = { ...size, railWidth: clampTotal(targetContent, paneCount) };
  }

  function stopOuterResize() {
    resizing = null;
    window.removeEventListener('pointermove', onOuterResize);
    window.dispatchEvent(new CustomEvent('soloe:rail-resize-end'));
    persistSize();
  }

  function startSplitterResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = 'splitter';
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    window.dispatchEvent(new CustomEvent('soloe:rail-resize-start'));
    window.addEventListener('pointermove', onSplitterResize);
    window.addEventListener('pointerup', stopSplitterResize, { once: true });
  }

  function onSplitterResize(event: PointerEvent) {
    // Splitter sits between slot 0 (left) and slot 1 (right). Dragging right
    // grows slot 0; we store the result as a ratio of the usable width so the
    // split survives rail-width changes.
    if (!asideEl) return;
    const rect = asideEl.getBoundingClientRect();
    const contentLeft = rect.left;
    const contentRight = rect.right - ICON_COL_WIDTH;
    const usable = contentRight - contentLeft - SPLITTER;
    if (usable <= 0) return;
    size = { ...size, splitRatio: clampSplitRatio((event.clientX - contentLeft) / usable) };
  }

  function stopSplitterResize() {
    resizing = null;
    window.removeEventListener('pointermove', onSplitterResize);
    window.dispatchEvent(new CustomEvent('soloe:rail-resize-end'));
    persistSize();
  }

  // Re-clamp the rail when something off-rail shrinks our budget: the
  // sidebar reappearing, or the window shrinking. Keeps the terminal at
  // or above its minimum without manual intervention.
  // Keep railWidth within bounds when the budget changes: the sidebar
  // reappearing or the window shrinking caps it, and opening a second pane
  // raises the floor to fit two panes (clampTotal grows it if needed). The
  // split ratio is preserved across all of these.
  $effect(() => {
    void sidebar.effectiveWidth;
    if (typeof window === 'undefined') return;
    if (openTabs.length === 0) return;
    const paneCount = openTabs.length >= 2 ? 2 : 1;
    const clamped = clampTotal(size.railWidth, paneCount);
    if (clamped !== size.railWidth) size = { ...size, railWidth: clamped };
  });

  // Auto-collapse the sidebar when opening a second pane wouldn't fit at
  // minimum widths. Keeps the click immediately useful instead of leaving
  // the user to figure out why nothing visible changed.
  $effect(() => {
    if (openTabs.length < 2) return;
    if (sidebar.hidden) return;
    if (typeof window === 'undefined') return;
    const needed = MIN_PANE_WIDTH * 2 + SPLITTER + ICON_COL_WIDTH + TERMINAL_MIN_WIDTH;
    const available = window.innerWidth - sidebar.effectiveWidth;
    if (available < needed) sidebar.hide();
  });

  // Order class for a tab's pane wrapper. Slot 0 (older click, leftmost)
  // gets order-1; slot 1 (newer click, next to icons) gets order-3. The
  // splitter sits at order-2. The icon nav is order-99. Tabs not in the
  // current worktree's open set are hidden so they stay mounted (for
  // diff/files keep-alive) without occupying layout space.
  function slotOrderClass(id: RailTabId): string {
    const slot = slotOf(id);
    if (slot === 0) return 'order-1';
    if (slot === 1) return 'order-3';
    return '';
  }

  function slotWidth(id: RailTabId): number {
    const slot = slotOf(id);
    if (slot === null) return 0;
    return paneWidths[slot];
  }

  // In fullscreen the chosen pane stretches; otherwise the slot dictates
  // the explicit width. Hidden mounted panes get display:none via the
  // hidden class so their width is irrelevant.
  function paneStyle(id: RailTabId): string | undefined {
    if (fullscreen && fullscreenTab === id) return undefined;
    if (slotOf(id) === null) return undefined;
    return `width: ${slotWidth(id)}px`;
  }

  function paneClasses(id: RailTabId, baseExtra = ''): string[] {
    const visible = tabVisible(id);
    const slot = slotOf(id);
    const ringed = visible && slot !== null && rightRail.focusedPaneSlot === slot;
    return [
      'relative flex min-w-0 flex-col border-r border-border',
      visible ? (fullscreen ? 'flex-1' : 'flex-shrink-0') : 'hidden',
      visible ? slotOrderClass(id) : '',
      // Inset ring so the accent appears inside the pane without nudging
      // siblings; only applied to the focused slot during a Ctrl+; cycle.
      ringed ? 'ring-2 ring-ring/70 ring-inset' : '',
      baseExtra
    ];
  }
</script>

<aside
  bind:this={asideEl}
  class={[
    'relative flex border-l border-border bg-sidebar',
    fullscreen ? 'min-w-0 flex-1' : 'flex-shrink-0',
    !railOpen && 'w-10',
    railOpen && 'overflow-hidden'
  ]}
  class:select-none={resizing}
  style={railOpen && !fullscreen ? `width: ${asideWidth}px` : undefined}
  aria-label="Session rail"
>
  <!-- Diff: kept mounted across worktree hops so its scroll/search/edits
       survive switching between worktrees that have it open. -->
  {#if diffMounted}
    <div class={paneClasses('diff')} style={paneStyle('diff')} data-pane-slot={slotOf('diff')}>
      <RailDiffTab />
    </div>
  {/if}

  <!-- Files: same keep-alive contract as diff. -->
  {#if filesMounted}
    <div class={paneClasses('files')} style={paneStyle('files')} data-pane-slot={slotOf('files')}>
      <RailFilesTab />
    </div>
  {/if}

  {#if featureMountedHere}
    <div class={paneClasses('feature')} style={paneStyle('feature')} data-pane-slot={slotOf('feature')}>
      <RailFeatureTab />
    </div>
  {/if}

  {#if browserMountedHere}
    <div class={paneClasses('browser')} style={paneStyle('browser')} data-pane-slot={slotOf('browser')}>
      <RailBrowserTab />
    </div>
  {/if}

  {#if inspectorMountedHere}
    <div class={paneClasses('inspector')} style={paneStyle('inspector')} data-pane-slot={slotOf('inspector')}>
      <ScrollArea class="min-h-0 flex-1">
        <RailInspectorTab />
      </ScrollArea>
    </div>
  {/if}

  {#if notesMountedHere}
    <div class={paneClasses('notes')} style={paneStyle('notes')} data-pane-slot={slotOf('notes')}>
      <RailNotesTab />
    </div>
  {/if}

  {#if twoPane && !fullscreen}
    <button
      type="button"
      class={`order-2 relative z-10 h-full w-1 flex-shrink-0 cursor-col-resize outline-none hover:bg-ring/30 focus-visible:bg-ring/40 ${resizing === 'splitter' ? 'bg-ring/20' : 'bg-transparent'}`}
      aria-label="Resize pane split"
      onpointerdown={startSplitterResize}
    ></button>
  {/if}

  <Tooltip.Provider delayDuration={250}>
    <nav class="order-[99] flex w-10 flex-shrink-0 flex-col items-center gap-1 pt-2" aria-label="Rail tabs">
      {#each tabs as tab (tab.id)}
        {@const isActive = openTabs.includes(tab.id)}
        {@const showDot = tab.id === 'feature' && featureNeedsSetup && !isActive}
        <Tooltip.Root disabled={kbdHints.altHeld}>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <div class="relative">
                <button
                  {...props}
                  type="button"
                  class={`flex size-8 items-center justify-center rounded-md transition-colors ${
                    isActive
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                  onclick={() => toggleRailTabAndFocus(tab.id)}
                  aria-label={tab.label}
                  aria-pressed={isActive}
                >
                  <tab.icon class="size-4" />
                </button>
                {#if showDot}
                  <span
                    class="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-amber-500 ring-1 ring-sidebar"
                    aria-hidden="true"
                  ></span>
                {/if}
                {#if kbdHints.altHeld && !isActive}
                  <div
                    class="pointer-events-none absolute top-1/2 right-full z-50 mr-2 -translate-y-1/2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md"
                  >
                    <span>{tab.label}</span>
                    {#if tab.shortcut}
                      <Kbd keys={[...tab.shortcut]} />
                    {/if}
                  </div>
                {/if}
              </div>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="left" class="flex items-center gap-1.5">
            <span>{tab.label}</span>
            {#if tab.shortcut}
              <Kbd keys={[...tab.shortcut]} />
            {/if}
          </Tooltip.Content>
        </Tooltip.Root>
      {/each}
      <div class="min-h-2 flex-1"></div>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <div
              {...props}
              role="note"
              aria-label="Switch focus between terminal and pane: Ctrl+;"
              class="flex flex-col items-center gap-0.5 pb-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <ArrowLeftRight class="size-3" />
              <kbd
                class="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded border border-border/70 bg-muted/70 px-1 font-mono text-[9px] leading-none tracking-tight"
                >Ctrl</kbd
              >
              <kbd
                class="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded border border-border/70 bg-muted/70 px-1 font-mono text-[9px] leading-none tracking-tight"
                >;</kbd
              >
            </div>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="left">Switch focus between terminal and pane</Tooltip.Content>
      </Tooltip.Root>
      <ProcessUsageWidget />
    </nav>
  </Tooltip.Provider>

  {#if railOpen && !fullscreen}
    <button
      type="button"
      class={`absolute top-0 left-[-3px] z-10 h-full w-1.5 cursor-col-resize outline-none hover:bg-ring/30 focus-visible:bg-ring/40 ${resizing === 'outer' ? 'bg-ring/20' : 'bg-transparent'}`}
      aria-label="Resize rail"
      onpointerdown={startOuterResize}
    >
      <span class="absolute bottom-1 left-1 block size-2 border-b border-l border-muted-foreground/60"></span>
    </button>
  {/if}
</aside>
