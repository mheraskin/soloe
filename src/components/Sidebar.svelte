<script lang="ts">
  import { onMount } from 'svelte';
  import { Plus, Search, FolderOpen } from '@lucide/svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { rankMulti } from '../lib/fuzzy';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import ProjectSection from './ProjectSection.svelte';
  import SessionItem from './SessionItem.svelte';

  const SIDEBAR_WIDTH_KEY = 'soloe.sidebarWidth.v1';
  const MIN_WIDTH = 220;
  const MAX_WIDTH = 460;

  let query = $state('');
  let width = $state(260);
  let resizing = $state(false);

  onMount(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(stored)) width = clampWidth(stored);
  });

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
  class="relative flex flex-shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
  class:select-none={resizing}
  style={`width: ${width}px`}
>
  <div class="flex flex-col gap-2 border-b border-border p-2.5">
    <Button
      variant="outline"
      size="sm"
      class="w-full justify-center gap-1.5"
      onclick={() => void sessions.createWithDefaults({}).catch(reportError)}
    >
      <Plus class="size-3.5" /> New session
    </Button>
    <Button
      variant="ghost"
      size="sm"
      class="w-full justify-center gap-1.5"
      onclick={() => commandPalette.open('open-project')}
    >
      <FolderOpen class="size-3.5" /> Open project
    </Button>
    <div class="relative">
      <Search class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        placeholder="Filter sessions"
        bind:value={query}
        class="h-7 pl-7 text-xs"
        aria-label="Filter sessions"
      />
    </div>
  </div>
  <ScrollArea class="flex-1">
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
