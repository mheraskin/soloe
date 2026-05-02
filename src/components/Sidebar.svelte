<script lang="ts">
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

  let query = $state('');

  let orderedProjectIds = $derived.by<string[]>(() => {
    const present = new Set(sessions.projectIds);
    const ordered: string[] = [];
    for (const p of projects.recents) {
      if (present.has(p.id)) ordered.push(p.id);
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
</script>

<aside class="flex w-[260px] flex-shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar">
  <div class="flex flex-col gap-2 border-b border-border p-2.5">
    <Button
      variant="outline"
      size="sm"
      class="w-full justify-center gap-1.5"
      onclick={() => void sessions.createWithDefaults({}).catch(reportError)}
    >
      <Plus class="size-3.5" /> New terminal
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
            <SessionItem {session} />
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
</aside>
