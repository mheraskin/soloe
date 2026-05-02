<script lang="ts">
  import { Plus, ChevronDown, ChevronRight, GitBranch } from '@lucide/svelte';
  import type { Session } from '@shared/types/sessions.js';
  import type { ProjectId } from '@shared/types/projects.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { rankMulti } from '../lib/fuzzy';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import SessionItem from './SessionItem.svelte';

  let {
    title,
    cwd,
    projectId,
    items,
    isMain = false,
    filter = ''
  }: {
    title: string;
    cwd: string;
    projectId: ProjectId | null;
    items: Session[];
    isMain?: boolean;
    filter?: string;
  } = $props();

  let expanded = $state(true);

  let visible = $derived.by(() => {
    const q = filter.trim();
    if (!q) return items;
    return rankMulti(q, items, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });
  let hidden = $derived(filter.trim().length > 0 && visible.length === 0);

  function addSession(e: Event) {
    e.stopPropagation();
    void sessions
      .createWithDefaults({
        ...(projectId ? { projectId } : {}),
        cwd,
        ...(title ? { branch: title } : {})
      })
      .catch(reportError);
  }
</script>

{#if !hidden}
  <Collapsible.Root bind:open={expanded} class="flex flex-col gap-0.5">
    <div class="flex items-center gap-px px-0.5 py-0.5">
      <Collapsible.Trigger
        class="flex flex-1 items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Toggle worktree ${title}`}
      >
        {#if expanded}
          <ChevronDown class="size-2.5 shrink-0" />
        {:else}
          <ChevronRight class="size-2.5 shrink-0" />
        {/if}
        <GitBranch class="size-2.5 shrink-0" />
        <span class="flex-1 truncate font-mono text-[11px]" title={cwd}>{title}</span>
        {#if isMain}
          <Badge variant="outline" class="h-4 rounded-full px-1.5 text-[9px] font-normal tracking-wider uppercase">main</Badge>
        {/if}
        <Badge variant="secondary" class="h-4 rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground">
          {items.length}
        </Badge>
      </Collapsible.Trigger>
      <Button
        variant="ghost"
        size="icon-xs"
        onclick={addSession}
        title="New terminal in this worktree"
        aria-label="New terminal in this worktree"
      >
        <Plus />
      </Button>
    </div>
    <Collapsible.Content class="flex flex-col gap-px pl-3.5">
      {#each visible as session (session.id)}
        <SessionItem {session} branch={title} />
      {/each}
    </Collapsible.Content>
  </Collapsible.Root>
{/if}
