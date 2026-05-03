<script lang="ts">
  import { ChevronDown, ChevronRight, FolderGit2 } from '@lucide/svelte';
  import type { Session } from '@shared/types/sessions.js';
  import type { ProjectId } from '@shared/types/projects.js';
  import { sessions } from '../stores/sessions.svelte';
  import { rankMulti, score } from '../lib/fuzzy';
  import { cn } from '$lib/utils';
  import { Badge } from '$lib/components/ui/badge';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import SessionItem from './SessionItem.svelte';
  import AgentLaunchPopover from './AgentLaunchPopover.svelte';

  let {
    title,
    cwd,
    projectId,
    items,
    isMain = false,
    filter = '',
    forceShow = false
  }: {
    title: string;
    cwd: string;
    projectId: ProjectId | null;
    items: Session[];
    isMain?: boolean;
    filter?: string;
    forceShow?: boolean;
  } = $props();

  let expanded = $state(true);

  let trimmedFilter = $derived(filter.trim());
  let labelMatches = $derived.by(() => {
    if (!trimmedFilter) return false;
    return score(trimmedFilter, title) !== null;
  });
  let visible = $derived.by(() => {
    if (!trimmedFilter) return items;
    if (forceShow || labelMatches) return items;
    return rankMulti(trimmedFilter, items, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });
  let hidden = $derived(
    trimmedFilter.length > 0 && !forceShow && !labelMatches && visible.length === 0
  );
  let containsSelected = $derived.by(() => {
    const selId = sessions.selectedId;
    if (!selId) return false;
    return items.some((s) => s.id === selId);
  });
  // When the worktree group is collapsed but holds the selected session, the
  // header takes on the selected look so the user keeps a visual anchor.
  let highlightWhenCollapsed = $derived(containsSelected && !expanded);
</script>

{#if !hidden}
  <Collapsible.Root bind:open={expanded} class="flex flex-col gap-1">
    <div class="flex items-center gap-1 px-0.5 py-0.5">
      <Collapsible.Trigger
        class={cn(
          'flex flex-1 items-center gap-2 overflow-hidden rounded-md border border-transparent px-2 py-1 text-left transition-colors',
          highlightWhenCollapsed
            ? 'bg-accent/60 border-border text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
        aria-label={`Toggle worktree ${title}`}
      >
        {#if expanded}
          <ChevronDown class="size-3 shrink-0" />
        {:else}
          <ChevronRight class="size-3 shrink-0" />
        {/if}
        <FolderGit2 class="size-3.5 shrink-0" />
        <span class="flex-1 truncate font-mono text-xs leading-4" title={cwd}>{title}</span>
        {#if isMain}
          <Badge variant="outline" class="h-4 rounded-full px-1.5 text-[9px] font-medium tracking-wider uppercase">main</Badge>
        {/if}
        <Badge variant="secondary" class="h-4 rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          {items.length}
        </Badge>
      </Collapsible.Trigger>
      <AgentLaunchPopover
        {projectId}
        {cwd}
        branch={title}
        title="New session in this worktree"
        ariaLabel="New session in this worktree"
      />
    </div>
    <Collapsible.Content class="flex flex-col gap-px pl-4">
      {#each visible as session (session.id)}
        <SessionItem {session} branch={title} />
      {/each}
    </Collapsible.Content>
  </Collapsible.Root>
{/if}
