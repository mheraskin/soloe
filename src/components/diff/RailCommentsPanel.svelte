<script lang="ts">
  import {
    ArrowLeft,
    Check,
    ChevronDown,
    ChevronRight,
    Loader2,
    RotateCcw,
    Send,
    Trash2
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import type { DiffComment } from '../../stores/diff-comments.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { reportError, toasts } from '../../stores/toast.svelte';
  import { sendComments } from '../../lib/diff-comment-sender';
  import {
    commentAgents,
    parseMentions,
    type CommentAgent
  } from '../../stores/comment-agents.svelte';
  import AgentBadge from './AgentBadge.svelte';

  type Tab = 'active' | 'outdated' | 'resolved';

  interface Props {
    cwd: string;
    onClose: () => void;
  }

  let { cwd, onClose }: Props = $props();

  let tab = $state<Tab>('active');
  // Per-id "send in flight" flags. Reassigned on each toggle so derived reads
  // pick up the change — Svelte 5 doesn't track mutation of plain Records.
  let sendingById = $state<Record<string, boolean>>({});
  let sendingAll = $state(false);
  // Per-id "show full anchor context" flags. The collapsed preview shows the
  // anchored lines only; expanding adds the surrounding contextBefore /
  // contextAfter so reviewers don't need to jump to the diff to read context.
  let expandedById = $state<Record<string, boolean>>({});

  let allComments = $derived(diffComments.forWorktree(cwd));
  let activeComments = $derived(
    allComments.filter((c) => !c.resolvedAt && !diffComments.outdatedIds.has(c.id))
  );
  let outdatedComments = $derived(
    allComments.filter((c) => !c.resolvedAt && diffComments.outdatedIds.has(c.id))
  );
  let resolvedComments = $derived(allComments.filter((c) => c.resolvedAt));
  // Header total excludes resolved — they live in their own tab but shouldn't
  // pad the headline count that signals "stuff still needs attention".
  let unresolvedCount = $derived(allComments.length - resolvedComments.length);

  let visible = $derived(
    tab === 'active'
      ? activeComments
      : tab === 'outdated'
        ? outdatedComments
        : resolvedComments
  );

  let unsentInActive = $derived(
    activeComments.filter((c) => !c.sentAt && c.text.trim().length > 0)
  );

  let grouped = $derived.by<{ filePath: string; comments: DiffComment[] }[]>(() => {
    const map = new Map<string, DiffComment[]>();
    for (const c of visible) {
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

  // Jump to a comment's exact anchor. Selects the file (if different),
  // fires the highlight hint the diff viewer picks up to scroll into view
  // and flash the lines, then closes the panel so the diff is visible.
  function jumpToComment(c: DiffComment): void {
    workingDiff.setSelected(cwd, c.filePath);
    diffComments.highlightLines(c.cwd, c.filePath, c.side, c.startLine, c.endLine);
    onClose();
  }

  function toggleExpanded(id: string): void {
    expandedById = { ...expandedById, [id]: !expandedById[id] };
  }

  async function sendOne(id: string): Promise<void> {
    if (sendingById[id]) return;
    sendingById = { ...sendingById, [id]: true };
    try {
      const result = await sendComments([id]);
      if (result.delivered > 0) toasts.push('Sent', 'info');
      if (result.errors.length > 0) {
        toasts.push(result.errors[0] ?? 'Failed to send', 'error');
      }
    } catch (err) {
      reportError(err);
    } finally {
      sendingById = { ...sendingById, [id]: false };
    }
  }

  async function sendAllUnsent(): Promise<void> {
    if (sendingAll || unsentInActive.length === 0) return;
    sendingAll = true;
    try {
      const ids = unsentInActive.map((c) => c.id);
      const result = await sendComments(ids);
      if (result.delivered > 0) {
        toasts.push(
          `Sent ${result.delivered} comment${result.delivered === 1 ? '' : 's'}`,
          'info'
        );
      }
      if (result.errors.length > 0) {
        toasts.push(result.errors[0] ?? 'Some comments failed to send', 'error');
      }
    } catch (err) {
      reportError(err);
    } finally {
      sendingAll = false;
    }
  }

  function setResolved(id: string, value: boolean): void {
    diffComments.setResolved(id, value);
  }

  function deleteOne(id: string): void {
    diffComments.remove(id);
  }

  function agentsFor(c: DiffComment): CommentAgent[] {
    const out: CommentAgent[] = [];
    for (const name of parseMentions(c.text)) {
      const agent = commentAgents.byName(c.cwd, name);
      if (agent) out.push(agent);
    }
    return out;
  }

  let tabs = $derived<Array<{ id: Tab; label: string; count: number }>>([
    { id: 'active', label: 'Active', count: activeComments.length },
    { id: 'outdated', label: 'Outdated', count: outdatedComments.length },
    { id: 'resolved', label: 'Resolved', count: resolvedComments.length }
  ]);

  let emptyMessage = $derived(
    tab === 'active'
      ? 'No active comments.'
      : tab === 'outdated'
        ? 'No outdated comments — every anchor still matches.'
        : 'No resolved comments yet.'
  );
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
    <Button variant="ghost" size="xs" onclick={onClose} aria-label="Back to diff" title="Back">
      <ArrowLeft class="size-3" />
      <span>Back</span>
    </Button>
    <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
      Comments ({unresolvedCount})
    </span>
    <span class="w-12"></span>
  </header>

  <div class="flex shrink-0 border-b border-border">
    {#each tabs as t (t.id)}
      <button
        type="button"
        class={[
          'flex flex-1 items-center justify-center gap-1 border-b-2 px-2 py-1.5 text-xs transition-colors',
          tab === t.id
            ? 'border-foreground text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'
        ]}
        onclick={() => (tab = t.id)}
        aria-pressed={tab === t.id}
      >
        <span>{t.label}</span>
        <span class="text-muted-foreground/80">({t.count})</span>
      </button>
    {/each}
  </div>

  {#if tab === 'active' && unsentInActive.length > 0}
    <div
      class="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5"
    >
      <span class="text-[11px] text-muted-foreground">
        {unsentInActive.length} unsent
      </span>
      <Button
        variant="outline"
        size="xs"
        onclick={() => void sendAllUnsent()}
        disabled={sendingAll}
        aria-label="Send all unsent comments"
      >
        {#if sendingAll}
          <Loader2 class="size-3 animate-spin" />
        {:else}
          <Send class="size-3" />
        {/if}
        <span>Send {unsentInActive.length} unsent</span>
      </Button>
    </div>
  {/if}

  {#if visible.length === 0}
    <div
      class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground"
    >
      {emptyMessage}
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
              {@const isUnsent =
                !c.sentAt && c.text.trim().length > 0 && !c.resolvedAt}
              {@const agents = agentsFor(c)}
              {@const sending = sendingById[c.id] === true}
              {@const expanded = expandedById[c.id] === true}
              {@const hasContext =
                c.anchor !== undefined
                && (c.anchor.contextBefore.length > 0 || c.anchor.contextAfter.length > 0)}
              <article
                class="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5"
              >
                <div class="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    class="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                    onclick={() => jumpToComment(c)}
                    title="Jump to {c.filePath} {lineLabel(c)}"
                  >
                    <span class="truncate">{c.filePath}:{lineLabel(c)}</span>
                    {#if isUnsent}
                      <span
                        class="shrink-0 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] uppercase text-amber-700 dark:text-amber-400"
                      >
                        Unsent
                      </span>
                    {:else if c.sentAt && !c.resolvedAt}
                      <span
                        class="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] uppercase text-emerald-700 dark:text-emerald-400"
                      >
                        Sent
                      </span>
                    {/if}
                  </button>
                  <div class="flex shrink-0 items-center gap-0.5">
                    {#if isUnsent}
                      <Button
                        variant="ghost"
                        size="xs"
                        onclick={() => void sendOne(c.id)}
                        disabled={sending}
                        aria-label="Send comment"
                        title="Send"
                      >
                        {#if sending}
                          <Loader2 class="size-3 animate-spin" />
                        {:else}
                          <Send class="size-3" />
                        {/if}
                      </Button>
                    {/if}
                    {#if c.resolvedAt}
                      <Button
                        variant="ghost"
                        size="xs"
                        onclick={() => setResolved(c.id, false)}
                        aria-label="Reopen comment"
                        title="Reopen"
                      >
                        <RotateCcw class="size-3" />
                      </Button>
                    {:else}
                      <Button
                        variant="ghost"
                        size="xs"
                        onclick={() => setResolved(c.id, true)}
                        aria-label="Resolve comment"
                        title="Resolve"
                      >
                        <Check class="size-3" />
                      </Button>
                    {/if}
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
                {#if c.anchor}
                  <div
                    class="overflow-hidden rounded border border-dashed border-border/60 bg-background/40 font-mono text-[10px] leading-snug text-muted-foreground"
                    title={tab === 'outdated'
                      ? 'Original line content at the time the comment was made'
                      : 'Anchored line content'}
                  >
                    {#if expanded && c.anchor.contextBefore.length > 0}
                      <pre
                        class="max-h-24 overflow-auto whitespace-pre-wrap px-2 pt-1 text-muted-foreground/70"
                      >{c.anchor.contextBefore.join('\n')}</pre>
                    {/if}
                    <pre
                      class="max-h-40 overflow-auto whitespace-pre-wrap px-2 py-1 text-foreground/85"
                    >{c.anchor.text.join('\n') || '(empty line)'}</pre>
                    {#if expanded && c.anchor.contextAfter.length > 0}
                      <pre
                        class="max-h-24 overflow-auto whitespace-pre-wrap px-2 pb-1 text-muted-foreground/70"
                      >{c.anchor.contextAfter.join('\n')}</pre>
                    {/if}
                    {#if hasContext}
                      <button
                        type="button"
                        class="flex w-full items-center justify-center gap-1 border-t border-border/60 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                        onclick={() => toggleExpanded(c.id)}
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Hide context' : 'Show context'}
                        title={expanded ? 'Hide context' : 'Show surrounding lines'}
                      >
                        {#if expanded}
                          <ChevronDown class="size-3" />
                          <span>Hide context</span>
                        {:else}
                          <ChevronRight class="size-3" />
                          <span>Show context</span>
                        {/if}
                      </button>
                    {/if}
                  </div>
                {/if}
                <pre
                  class="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs leading-snug text-foreground/90"
                >{c.text || '(empty)'}</pre>
                {#if agents.length > 0}
                  <div class="flex flex-wrap items-center gap-1">
                    {#each agents as agent (agent.id)}
                      <AgentBadge
                        name={agent.name}
                        provider={agent.provider}
                        model={agent.model}
                      />
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
