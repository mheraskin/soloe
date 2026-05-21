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
  import { withScenarioWidths, type ScenarioId, type ScenarioWidths } from '../lib/rail-widths';
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

  // Per-scenario widths. Each of the three standard layouts has its own
  // memory so dragging in one (e.g. sidebar visible + 1 rail) doesn't move
  // the others. Defaults are ratios of viewport — see RATIO_* below.
  //
  //   A: sidebar visible + 1 rail pane → 30% rail (the 30/40/30 column feel)
  //   B: sidebar hidden  + 1 rail pane → 50% rail (terminal/rail even split)
  //   C: 2 rail panes (sidebar usually auto-collapses)
  //         slot 0 (central, main)  → 55%
  //         slot 1 (notes-style)    → pinned to MIN_PANE_WIDTH
  const SCENARIO_KEY = 'soloe.rail.scenarioWidths.v1';
  const ICON_COL_WIDTH = 40;
  const MIN_PANE_WIDTH = 220;
  const TERMINAL_MIN_WIDTH = 220;
  const FALLBACK_PANE_WIDTH = 480;

  const RATIO_A = 0.30;
  const RATIO_B = 0.50;
  const RATIO_C0 = 0.55;

  function computeDefaultWidths(): ScenarioWidths {
    if (typeof window === 'undefined') {
      return {
        A: FALLBACK_PANE_WIDTH,
        B: FALLBACK_PANE_WIDTH,
        C0: FALLBACK_PANE_WIDTH,
        C1: MIN_PANE_WIDTH
      };
    }
    const vp = window.innerWidth;
    return {
      A: Math.max(MIN_PANE_WIDTH, Math.round(vp * RATIO_A)),
      B: Math.max(MIN_PANE_WIDTH, Math.round(vp * RATIO_B)),
      C0: Math.max(MIN_PANE_WIDTH, Math.round(vp * RATIO_C0)),
      C1: MIN_PANE_WIDTH
    };
  }

  function loadScenarioWidths(): ScenarioWidths {
    if (typeof localStorage === 'undefined') return computeDefaultWidths();
    try {
      const raw = localStorage.getItem(SCENARIO_KEY);
      if (!raw) return computeDefaultWidths();
      const parsed = JSON.parse(raw) as Partial<ScenarioWidths>;
      const d = computeDefaultWidths();
      const sanitize = (v: unknown, fallback: number) =>
        typeof v === 'number' && Number.isFinite(v)
          ? Math.max(MIN_PANE_WIDTH, Math.round(v))
          : fallback;
      return {
        A: sanitize(parsed.A, d.A),
        B: sanitize(parsed.B, d.B),
        C0: sanitize(parsed.C0, d.C0),
        C1: sanitize(parsed.C1, d.C1)
      };
    } catch {
      return computeDefaultWidths();
    }
  }

  interface Props {
    // True when the active rail pane fills the entire main area (terminal
    // hidden). Suppresses the outer resize handle and the splitter.
    fullscreen?: boolean;
  }

  let { fullscreen = false }: Props = $props();

  let scenarioWidths = $state<ScenarioWidths>(computeDefaultWidths());
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

  // The active scenario picks which scenarioWidths entry drives layout.
  // Two open panes always use C (even if the sidebar is visible — the
  // auto-collapse effect below normally hides the sidebar in that case).
  let currentScenario = $derived.by<ScenarioId>(() => {
    if (openTabs.length === 2) return 'C';
    return sidebar.hidden ? 'B' : 'A';
  });

  // paneWidths is a thin view over scenarioWidths so every read of slot 0/1
  // already reflects the active scenario. Drag handlers write back through
  // setScenarioWidths so persistence stays scoped to one scenario at a time.
  let paneWidths = $derived.by<[number, number]>(() => {
    if (currentScenario === 'A') return [scenarioWidths.A, MIN_PANE_WIDTH];
    if (currentScenario === 'B') return [scenarioWidths.B, MIN_PANE_WIDTH];
    return [scenarioWidths.C0, scenarioWidths.C1];
  });

  function setScenarioWidths(slot0: number, slot1: number): void {
    const next = withScenarioWidths(currentScenario, scenarioWidths, slot0, slot1);
    if (next === scenarioWidths) return;
    scenarioWidths = next;
  }

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
          : paneWidths[0] + paneWidths[1] + 4 // +4 for the splitter
  );
  let asideWidth = $derived(contentWidth + ICON_COL_WIDTH);

  onMount(() => {
    scenarioWidths = loadScenarioWidths();
  });

  function persistScenarioWidths(): void {
    try {
      localStorage.setItem(SCENARIO_KEY, JSON.stringify(scenarioWidths));
    } catch {
      // Quota — ignore.
    }
  }

  function maxContentWidth(): number {
    const sidebarW = sidebar.effectiveWidth;
    return Math.max(MIN_PANE_WIDTH, window.innerWidth - sidebarW - TERMINAL_MIN_WIDTH - ICON_COL_WIDTH);
  }

  function clampTotal(target: number, paneCount: number): number {
    const splitter = paneCount === 2 ? 4 : 0;
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
    // Outer handle sits at the rail's left edge. Dragging left grows
    // the rail. Total content = window - clientX - icon column.
    const targetContent = window.innerWidth - event.clientX - ICON_COL_WIDTH;
    if (openTabs.length <= 1) {
      setScenarioWidths(clampTotal(targetContent, 1), paneWidths[1]);
      return;
    }
    const total = clampTotal(targetContent, 2) - 4; // discount splitter
    const prevTotal = paneWidths[0] + paneWidths[1] || total;
    const ratio = total / prevTotal;
    let nextA = Math.max(MIN_PANE_WIDTH, Math.round(paneWidths[0] * ratio));
    let nextB = Math.max(MIN_PANE_WIDTH, total - nextA);
    if (nextA + nextB > total) nextA = total - nextB;
    if (nextA < MIN_PANE_WIDTH) {
      nextA = MIN_PANE_WIDTH;
      nextB = Math.max(MIN_PANE_WIDTH, total - nextA);
    }
    setScenarioWidths(nextA, nextB);
  }

  function stopOuterResize() {
    resizing = null;
    window.removeEventListener('pointermove', onOuterResize);
    window.dispatchEvent(new CustomEvent('soloe:rail-resize-end'));
    persistScenarioWidths();
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
    // Splitter sits between pane 1 (left) and pane 2 (right). Dragging
    // right grows pane 1 at the expense of pane 2.
    if (!asideEl) return;
    const rect = asideEl.getBoundingClientRect();
    const contentLeft = rect.left;
    const contentRight = rect.right - ICON_COL_WIDTH;
    const total = contentRight - contentLeft - 4; // discount splitter width
    let nextA = event.clientX - contentLeft;
    nextA = Math.max(MIN_PANE_WIDTH, Math.min(total - MIN_PANE_WIDTH, Math.round(nextA)));
    setScenarioWidths(nextA, total - nextA);
  }

  function stopSplitterResize() {
    resizing = null;
    window.removeEventListener('pointermove', onSplitterResize);
    window.dispatchEvent(new CustomEvent('soloe:rail-resize-end'));
    persistScenarioWidths();
  }

  // Re-clamp the rail when something off-rail shrinks our budget: the
  // sidebar reappearing, or the window shrinking. Keeps the terminal at
  // or above its minimum without manual intervention.
  $effect(() => {
    void sidebar.effectiveWidth;
    if (typeof window === 'undefined') return;
    if (openTabs.length === 0) return;
    const max = maxContentWidth();
    if (openTabs.length === 1) {
      if (paneWidths[0] > max) setScenarioWidths(Math.max(MIN_PANE_WIDTH, max), paneWidths[1]);
      return;
    }
    const total = paneWidths[0] + paneWidths[1];
    if (total + 4 <= max) return;
    const budget = max - 4;
    const ratio = budget / total;
    let nextA = Math.max(MIN_PANE_WIDTH, Math.round(paneWidths[0] * ratio));
    let nextB = Math.max(MIN_PANE_WIDTH, budget - nextA);
    if (nextA + nextB > budget) nextA = budget - nextB;
    if (nextA < MIN_PANE_WIDTH) {
      nextA = MIN_PANE_WIDTH;
      nextB = Math.max(MIN_PANE_WIDTH, budget - nextA);
    }
    setScenarioWidths(nextA, nextB);
  });

  // Auto-collapse the sidebar when opening a second pane wouldn't fit at
  // minimum widths. Keeps the click immediately useful instead of leaving
  // the user to figure out why nothing visible changed.
  $effect(() => {
    if (openTabs.length < 2) return;
    if (sidebar.hidden) return;
    if (typeof window === 'undefined') return;
    const needed = MIN_PANE_WIDTH * 2 + 4 + ICON_COL_WIDTH + TERMINAL_MIN_WIDTH;
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
