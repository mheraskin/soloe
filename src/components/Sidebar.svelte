<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Plus, Search, FolderOpen, X } from '@lucide/svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { commandPalette } from '../stores/command-palette.svelte';
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

  const SIDEBAR_WIDTH_KEY = 'soloe.sidebarWidth.v1';
  const MIN_WIDTH = 220;
  const MAX_WIDTH = 460;

  let query = $state('');
  let width = $state(260);
  let resizing = $state(false);
  let asideEl: HTMLElement | null = $state(null);
  let scrollViewport: HTMLElement | null = $state(null);
  let lastScrolledId: string | null = null;
  let lastScrolledNewProjectId: string | null = null;

  onMount(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(stored)) width = clampWidth(stored);
  });

  // Keep the selected row visible. Runs on initial restore (when localStorage
  // brings back a selectedId) and whenever selection changes programmatically
  // — clicking a row that's already visible is a no-op for the centred scroll.
  $effect(() => {
    const id = sessions.selectedId;
    if (!id || !asideEl || id === lastScrolledId) return;
    lastScrolledId = id;
    void tick().then(() => {
      requestAnimationFrame(() => {
        const row = asideEl?.querySelector(`[data-session-id="${CSS.escape(id)}"]`);
        if (row instanceof HTMLElement && scrollViewport) {
          scrollIntoViewCentered(row, scrollViewport);
        }
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
        const row = asideEl?.querySelector(`[data-project-id="${CSS.escape(id)}"]`);
        if (row instanceof HTMLElement && scrollViewport) {
          scrollIntoViewCentered(row, scrollViewport);
        }
        projects.consumeNewlyAdded(id);
      });
    });
  });

  $effect(() => {
    if (sessions.selectedId === null) lastScrolledId = null;
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

  function onSidebarDragLeave() {
    // Cursor left the sidebar entirely — clear any lingering drop target so
    // the indicator doesn't stay stuck on the last hovered row.
    if (dnd.drag) dnd.setTarget(null);
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

  function clampWidth(value: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
  }

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = true;
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stopResize, { once: true });
  }

  function resize(event: PointerEvent) {
    width = clampWidth(event.clientX);
  }

  function stopResize() {
    resizing = false;
    window.removeEventListener('pointermove', resize);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }
</script>

<aside
  bind:this={asideEl}
  class="relative flex flex-shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
  class:select-none={resizing}
  style={`width: ${width}px`}
  ondragleave={onSidebarDragLeave}
>
  <div class="flex flex-col gap-2 border-b border-border p-2.5">
    <div class="grid grid-cols-2 gap-2">
      <Button
        variant="ghost"
        size="sm"
        class="min-w-0 justify-center gap-1.5 px-2"
        onclick={() => commandPalette.open('open-project')}
      >
        <FolderOpen class="size-3.5" />
        <span class="min-w-0 truncate">Open project</span>
        <KbdHint keys={Keymap.openProject.keys} class="ml-0.5 shrink-0" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="min-w-0 justify-center gap-1.5 px-2"
        onclick={() => void sessions.createWithDefaults({}).catch(reportError)}
      >
        <Plus class="size-3.5" />
        <span class="min-w-0 truncate">New session</span>
        <KbdHint keys={Keymap.newSession.keys} class="ml-0.5 shrink-0" />
      </Button>
    </div>
    <div class="relative">
      <Search class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        placeholder="Filter sessions"
        bind:value={query}
        class="h-7 pr-7 pl-7 text-xs [&::-webkit-search-cancel-button]:hidden"
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
  </div>
  <ScrollArea class="flex-1" bind:viewportRef={scrollViewport}>
    <div class="flex flex-col gap-3 p-2">
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
    class={`absolute top-0 right-[-3px] z-10 h-full w-1.5 cursor-col-resize outline-none hover:bg-ring/30 focus-visible:bg-ring/40 ${resizing ? 'bg-ring/20' : 'bg-transparent'}`}
    aria-label="Resize sidebar"
    onpointerdown={startResize}
  >
    <span class="absolute right-1 bottom-1 block size-2 border-r border-b border-muted-foreground/60"></span>
  </button>
</aside>
