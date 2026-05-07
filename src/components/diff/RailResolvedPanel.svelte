<script lang="ts">
  import { ArrowLeft, RotateCcw, Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import type { DiffComment } from '../../stores/diff-comments.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { commentAgents, parseMentions, type CommentAgent } from '../../stores/comment-agents.svelte';
  import AgentBadge from './AgentBadge.svelte';

  interface Props {
    cwd: string;
    onClose: () => void;
  }

  let { cwd, onClose }: Props = $props();

  let comments = $derived(diffComments.resolvedForWorktree(cwd));

  // Group by filePath so the rail mirrors the diff's file-centric layout.
  let grouped = $derived.by<{ filePath: string; comments: DiffComment[] }[]>(() => {
    const map = new Map<string, DiffComment[]>();
    for (const c of comments) {
      const list = map.get(c.filePath) ?? [];
      list.push(c);
      map.set(c.filePath, list);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([filePath, list]) => ({
        filePath,
        comments: list.sort((a, b) => a.startLine - b.startLine)
      }));
  });

  function lineLabel(c: DiffComment): string {
    return c.endLine === c.startLine
      ? `L${c.startLine}`
      : `L${c.startLine}–${c.endLine}`;
  }

  function jumpTo(filePath: string): void {
    workingDiff.setSelected(cwd, filePath);
    onClose();
  }

  function reopen(id: string): void {
    diffComments.setResolved(id, false);
  }

  function deleteOne(id: string): void {
    diffComments.remove(id);
  }

  function resolvedAgentsFor(c: DiffComment): CommentAgent[] {
    const out: CommentAgent[] = [];
    for (const name of parseMentions(c.text)) {
      const agent = commentAgents.byName(c.cwd, name);
      if (agent) out.push(agent);
    }
    return out;
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
    <Button variant="ghost" size="xs" onclick={onClose} aria-label="Back to diff" title="Back">
      <ArrowLeft class="size-3" />
      <span>Back</span>
    </Button>
    <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
      Resolved ({comments.length})
    </span>
    <span class="w-12"></span>
  </header>

  {#if comments.length === 0}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      No resolved comments yet.
    </div>
  {:else}
    <ScrollArea class="min-h-0 flex-1">
      <div class="flex flex-col gap-3 p-2">
        {#each grouped as group (group.filePath)}
          <section class="flex flex-col gap-1.5">
            <button
              type="button"
              class="flex items-center gap-1 px-1 text-left text-[10px] font-medium tracking-wider text-muted-foreground uppercase hover:text-foreground"
              onclick={() => jumpTo(group.filePath)}
              title="Jump to {group.filePath}"
            >
              <span class="truncate font-mono normal-case">{group.filePath}</span>
              <span class="shrink-0">({group.comments.length})</span>
            </button>
            {#each group.comments as c (c.id)}
              {@const agents = resolvedAgentsFor(c)}
              <article
                class="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5"
              >
                <div class="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    class="font-mono text-[10px] text-muted-foreground hover:text-foreground"
                    onclick={() => jumpTo(c.filePath)}
                    title="Jump to {c.filePath} {lineLabel(c)}"
                  >
                    {c.filePath}:{lineLabel(c)}
                  </button>
                  <div class="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="xs"
                      onclick={() => reopen(c.id)}
                      aria-label="Reopen comment"
                      title="Reopen"
                    >
                      <RotateCcw class="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onclick={() => deleteOne(c.id)}
                      aria-label="Delete comment"
                      title="Delete"
                    >
                      <Trash2 class="size-3" />
                    </Button>
                  </div>
                </div>
                <pre
                  class="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs leading-snug text-foreground/90"
                >{c.text || '(empty)'}</pre>
                {#if agents.length > 0}
                  <div class="flex flex-wrap items-center gap-1">
                    {#each agents as agent (agent.id)}
                      <AgentBadge name={agent.name} provider={agent.provider} model={agent.model} />
                    {/each}
                  </div>
                {/if}
              </article>
            {/each}
          </section>
        {/each}
      </div>
    </ScrollArea>
  {/if}
</div>
