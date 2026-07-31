<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { ArrowRight, Search, FolderOpen, X, PanelLeftClose, Settings } from '@lucide/svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { settings } from '../stores/settings.svelte';
  import {
    sidebar,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH
  } from '../stores/sidebar.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { rankMulti } from '../lib/fuzzy';
  import { Keymap } from '../lib/keymap';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { scrollIntoViewCentered } from '../lib/scroll-into-view-center';
  import { dnd, type DropPosition } from '../stores/dnd.svelte';
  import KbdHint from './KbdHint.svelte';
  import ProjectSection from './ProjectSection.svelte';
  import SessionItem from './SessionItem.svelte';
  import AgentLaunchPopover from './AgentLaunchPopover.svelte';

  const MIN_WIDTH = SIDEBAR_MIN_WIDTH;
  const MAX_WIDTH = SIDEBAR_MAX_WIDTH;
  // Re-centre the target row a few times after the initial scroll. Async
  // content (git worktrees, project sections expanding) shifts heights for a
  // few hundred ms after mount; without this the row appears off-screen on
  // app open.
  const SCROLL_SETTLE_DELAYS_MS = [150, 350, 600];
  // Auto-scroll while a drag is hovering near the top/bottom of the sidebar.
  const EDGE_SCROLL_THRESHOLD = 60;
  const EDGE_SCROLL_MAX_SPEED = 18;
  const EDGE_SCROLL_MIN_SPEED = 4;

  interface Props {
    mobileWorkspace?: boolean;
    onRequestTerminal?: () => void;
    onSessionActivate?: () => void;
  }

  let { mobileWorkspace = false, onRequestTerminal, onSessionActivate }: Props = $props();
  let query = $state('');
  let resizing = $state(false);
  let asideEl: HTMLElement | null = $state(null);
  let scrollViewport: HTMLElement | null = $state(null);
  let lastScrolledId: string | null = null;
  let lastScrolledNewProjectId: string | null = null;
  let settleTimers: ReturnType<typeof setTimeout>[] = [];
  let edgeScrollSpeed = 0;
  let edgeScrollFrame: number | null = null;

  // Width comes from the sidebar store now so the rail can clamp against
  // it without measuring the DOM. The store owns persistence too.
  let width = $derived(sidebar.width);
  let newSessionContext = $derived.by(() => {
    const selected = sessions.selected;
    return {
      ...(selected?.projectId ? { projectId: selected.projectId } : {}),
      ...(selected?.cwd ? { cwd: selected.cwd } : {}),
      ...(selected?.lastBranch ? { branch: selected.lastBranch } : {})
    };
  });

  function clearSettleTimers() {
    for (const t of settleTimers) clearTimeout(t);
    settleTimers = [];
  }

  function findRow(selector: string): HTMLElement | null {
    if (!asideEl) return null;
    const el = asideEl.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }

  // Centre the row now, then re-centre over the next ~600ms when it drifts
  // far off-centre. Drift checks gate the re-centre so a stable layout never
  // triggers a second scroll.
  function scrollAndSettle(selector: string) {
    if (!scrollViewport) return;
    clearSettleTimers();
    const initial = findRow(selector);
    if (initial) scrollIntoViewCentered(initial, scrollViewport);
    for (const delay of SCROLL_SETTLE_DELAYS_MS) {
      settleTimers.push(setTimeout(() => {
        const row = findRow(selector);
        if (!row || !scrollViewport) return;
        const rect = row.getBoundingClientRect();
        const vp = scrollViewport.getBoundingClientRect();
        const drift = Math.abs((rect.top + rect.height / 2) - (vp.top + vp.height / 2));
        if (drift > vp.height / 4) {
          scrollIntoViewCentered(row, scrollViewport, { behavior: 'auto' });
        }
      }, delay));
    }
  }

  // Keep the selected row visible. Runs on initial restore (when localStorage
  // brings back a selectedId) and whenever selection changes programmatically
  // — clicking a row that's already visible is a no-op for the centred scroll.
  $effect(() => {
    const id = sessions.selectedId;
    if (!id || !asideEl || id === lastScrolledId) return;
    lastScrolledId = id;
    void tick().then(() => {
      requestAnimationFrame(() => {
        scrollAndSettle(`[data-session-id="${CSS.escape(id)}"]`);
      });
    });
  });

  // Scroll a freshly added project to the centre so the user immediately sees
  // where it landed at the bottom of the list.
  $effect(() => {
    const id = projects.newlyAddedId;
    if (!id || !asideEl || id === lastScrolledNewProjectId) return;
    lastScrolledNewProjectId = id;
    void tick().then(() => {
      requestAnimationFrame(() => {
        scrollAndSettle(`[data-project-id="${CSS.escape(id)}"]`);
        projects.consumeNewlyAdded(id);
      });
    });
  });

  $effect(() => {
    if (sessions.selectedId === null) lastScrolledId = null;
  });

  // While dragging, auto-scroll the viewport when the cursor approaches its
  // top or bottom edge so the user can reach off-screen drop targets.
  function tickEdgeScroll() {
    edgeScrollFrame = null;
    if (!scrollViewport || edgeScrollSpeed === 0 || !dnd.drag) return;
    const before = scrollViewport.scrollTop;
    scrollViewport.scrollTop = before + edgeScrollSpeed;
    if (scrollViewport.scrollTop !== before) {
      edgeScrollFrame = requestAnimationFrame(tickEdgeScroll);
    }
  }

  function onAsideDragOver(e: DragEvent) {
    if (!dnd.drag || !scrollViewport) {
      edgeScrollSpeed = 0;
      return;
    }
    const rect = scrollViewport.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    if (offsetY < EDGE_SCROLL_THRESHOLD) {
      const ratio = Math.max(0, Math.min(1, (EDGE_SCROLL_THRESHOLD - offsetY) / EDGE_SCROLL_THRESHOLD));
      edgeScrollSpeed = -Math.max(EDGE_SCROLL_MIN_SPEED, Math.round(ratio * EDGE_SCROLL_MAX_SPEED));
    } else if (offsetY > rect.height - EDGE_SCROLL_THRESHOLD) {
      const ratio = Math.max(0, Math.min(1, (offsetY - (rect.height - EDGE_SCROLL_THRESHOLD)) / EDGE_SCROLL_THRESHOLD));
      edgeScrollSpeed = Math.max(EDGE_SCROLL_MIN_SPEED, Math.round(ratio * EDGE_SCROLL_MAX_SPEED));
    } else {
      edgeScrollSpeed = 0;
      return;
    }
    if (edgeScrollFrame === null) {
      edgeScrollFrame = requestAnimationFrame(tickEdgeScroll);
    }
  }

  $effect(() => {
    if (dnd.drag === null) {
      edgeScrollSpeed = 0;
      if (edgeScrollFrame !== null) {
        cancelAnimationFrame(edgeScrollFrame);
        edgeScrollFrame = null;
      }
    }
  });

  function onProjectDrop(args: { draggedId: string; targetId: string; position: DropPosition }) {
    const { draggedId, targetId, position } = args;
    const ids = orderedProjectIds;
    if (!ids.includes(draggedId) || !ids.includes(targetId)) return;
    const without = ids.filter((id) => id !== draggedId);
    let insertAt = without.indexOf(targetId);
    if (insertAt < 0) insertAt = without.length;
    if (position === 'after') insertAt += 1;
    const next = [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
    if (sameOrder(ids, next)) return;
    void projects.reorder(next).catch(reportError);
  }

  function sameOrder(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  function onSidebarDragLeave(e: DragEvent) {
    // dragleave bubbles up from every descendant — when the cursor moves
    // between children inside the sidebar, the inner dragleave reaches us
    // even though we never actually left. Only clear the target when the
    // related target is outside the aside (or null = left the document).
    if (!dnd.drag) return;
    const related = e.relatedTarget;
    if (asideEl && related instanceof Node && asideEl.contains(related)) return;
    dnd.setTarget(null);
  }

  let orderedProjectIds = $derived.by<string[]>(() => {
    const ordered: string[] = [];
    for (const p of projects.recents) {
      ordered.push(p.id);
    }
    for (const id of sessions.projectIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  });

  let standaloneVisible = $derived.by(() => {
    const list = sessions.standalone;
    const q = query.trim();
    if (!q) return list;
    return rankMulti(q, list, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = true;
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stopResize, { once: true });
  }

  function resize(event: PointerEvent) {
    sidebar.setWidth(event.clientX);
  }

  function stopResize() {
    resizing = false;
    window.removeEventListener('pointermove', resize);
  }

  function notifyOnSessionActivation(node: HTMLElement) {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-session-id]')) {
        onSessionActivate?.();
      }
    };
    node.addEventListener('click', onClick);
    return {
      destroy: () => node.removeEventListener('click', onClick)
    };
  }
</script>

<aside
  bind:this={asideEl}
  class="app-sidebar relative flex flex-shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
  class:select-none={resizing}
  style={`width: ${width}px`}
  use:notifyOnSessionActivation
  ondragover={onAsideDragOver}
  ondragleave={onSidebarDragLeave}
>
  <div class="soloe-pane-header">
    <div class="flex w-full min-w-0 items-center gap-1.5">
      <div class="relative min-w-0 flex-1">
        <Search class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Filter sessions"
          bind:value={query}
          class="h-6 pr-6 pl-6 text-[11px] [&::-webkit-search-cancel-button]:hidden"
          aria-label="Filter sessions"
        />
        {#if query}
          <button
            type="button"
            class="absolute top-1/2 right-1.5 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Clear filter"
            title="Clear filter"
            onclick={() => (query = '')}
          >
            <X class="size-3" />
          </button>
        {/if}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        class="size-6 shrink-0"
        onclick={() => commandPalette.open('open-project')}
        aria-label="Open project"
        title="Open project"
      >
        <FolderOpen class="size-3.5" />
      </Button>
      <AgentLaunchPopover
        projectId={newSessionContext.projectId ?? null}
        cwd={newSessionContext.cwd}
        branch={newSessionContext.branch}
        side="bottom"
        align="end"
        class="size-6"
        title="New session"
        ariaLabel="New session"
      />
      {#if mobileWorkspace}
        <Button
          variant="ghost"
          class="mobile-workspace-menu-button size-6 shrink-0"
          onclick={() => settings.openDialog()}
          aria-label="Settings"
          title="Settings"
        >
          <Settings class="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          class="mobile-workspace-menu-button size-6 shrink-0"
          onclick={onRequestTerminal}
          aria-label="Return to terminal"
          title="Return to terminal"
        >
          <ArrowRight class="size-3.5" />
        </Button>
      {:else}
        <button
          type="button"
          class="flex h-6 shrink-0 items-center gap-1 rounded-md border border-transparent px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Hide sidebar"
          title="Hide sidebar"
          onclick={() => sidebar.hide()}
        >
          <PanelLeftClose class="size-3.5" />
          <KbdHint keys={Keymap.toggleSidebar.keys} class="shrink-0" />
        </button>
      {/if}
    </div>
  </div>
  <ScrollArea class="flex-1" bind:viewportRef={scrollViewport}>
    <div class="flex flex-col gap-1 p-1.5">
      {#if standaloneVisible.length > 0}
        <div class="flex flex-col gap-px">
          {#each standaloneVisible as session (session.id)}
            <SessionItem {session} branch={session.lastBranch ?? null} />
          {/each}
        </div>
      {/if}
      {#each orderedProjectIds as id (id)}
        {@const project = projects.get(id)}
        {#if project}
          <ProjectSection
            {project}
            sessions={sessions.byProject[id] ?? []}
            filter={query}
            {onProjectDrop}
          />
        {/if}
      {/each}
    </div>
  </ScrollArea>
  <button
    type="button"
    class={`sidebar-resize-handle absolute top-0 right-[-3px] z-10 h-full w-1.5 cursor-col-resize outline-none hover:bg-ring/30 focus-visible:bg-ring/40 ${resizing ? 'bg-ring/20' : 'bg-transparent'}`}
    aria-label="Resize sidebar"
    onpointerdown={startResize}
  >
    <span class="absolute right-1 bottom-1 block size-2 border-r border-b border-muted-foreground/60"></span>
  </button>
</aside>
