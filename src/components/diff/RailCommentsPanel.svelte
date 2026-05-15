<script lang="ts">
  import {
    Check,
    ChevronDown,
    ChevronRight,
    Loader2,
    MessageSquarePlus,
    RotateCcw,
    Send,
    Trash2
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Popover from '$lib/components/ui/popover';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { Textarea } from '$lib/components/ui/textarea';
  import type { AnchorLineKind, DiffComment } from '../../stores/diff-comments.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
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
  // Optional preamble for bulk-send. Lives behind the "with message" popover
  // next to the Send-all button so the fast path stays one click. Cleared on
  // a successful send so each batch starts fresh.
  let preambleText = $state('');
  let preambleOpen = $state(false);
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
    // Plain Map by design: this is a local helper inside a pure derived,
    // not reactive state. SvelteMap here loops because mutating it
    // invalidates the derived that's currently mutating it.
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

  // Drop fullscreen on send so the terminal becomes visible again — the
  // typical reason to send is to hand off to the agent running in it.
  function exitFullscreenForHandoff(): void {
    if (rightRail.fullscreen) rightRail.fullscreen = false;
  }

  async function sendOne(id: string): Promise<void> {
    if (sendingById[id]) return;
    sendingById = { ...sendingById, [id]: true };
    exitFullscreenForHandoff();
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

  async function sendAllUnsent(preamble?: string): Promise<void> {
    if (sendingAll || unsentInActive.length === 0) return;
    sendingAll = true;
    exitFullscreenForHandoff();
    try {
      const ids = unsentInActive.map((c) => c.id);
      const trimmed = preamble?.trim();
      const result = await sendComments(ids, trimmed || undefined);
      if (result.delivered > 0) {
        toasts.push(
          `Sent ${result.delivered} comment${result.delivered === 1 ? '' : 's'}`,
          'info'
        );
        // Drop the preamble + close the popover only after at least one
        // delivery — keeps the message editable for a retry when everything
        // failed.
        if (trimmed) {
          preambleText = '';
          preambleOpen = false;
        }
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

  // Per-line kinds for the anchored range. Older comments persisted before
  // this field was captured fall back to using the comment's `side` as a
  // proxy — side='old' only ever held remove/context, side='new' add/context,
  // so default to the change kind since most comments target changes.
  function anchorKinds(c: DiffComment): AnchorLineKind[] {
    const length = c.anchor?.text.length ?? 0;
    if (c.anchor?.kinds) return c.anchor.kinds;
    const fallback: AnchorLineKind = c.side === 'old' ? 'remove' : 'add';
    return Array.from({ length }, () => fallback);
  }

  function lineBg(kind: AnchorLineKind): string {
    if (kind === 'add') return 'bg-emerald-500/10 dark:bg-emerald-500/12';
    if (kind === 'remove') return 'bg-rose-500/10 dark:bg-rose-500/12';
    return '';
  }

  function linePrefixColor(kind: AnchorLineKind): string {
    if (kind === 'add') return 'text-emerald-600 dark:text-emerald-400';
    if (kind === 'remove') return 'text-rose-600 dark:text-rose-400';
    return 'text-muted-foreground/40';
  }

  function linePrefixChar(kind: AnchorLineKind): string {
    if (kind === 'add') return '+';
    if (kind === 'remove') return '−';
    return ' ';
  }

  let tabs = $derived<Array<{ id: Tab; label: string; count: number }>>(
    (
      [
        { id: 'active', label: 'Active', count: activeComments.length },
        { id: 'outdated', label: 'Outdated', count: outdatedComments.length },
        { id: 'resolved', label: 'Resolved', count: resolvedComments.length }
      ] as Array<{ id: Tab; label: string; count: number }>
    ).filter((t) => t.count > 0 || t.id === tab)
  );

  let emptyMessage = $derived(
    tab === 'active'
      ? 'No active comments.'
      : tab === 'outdated'
        ? 'No outdated comments — every anchor still matches.'
        : 'No resolved comments yet.'
  );
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex shrink-0 items-stretch justify-between gap-1 border-b border-border">
    <div class="flex items-end gap-1">
      {#each tabs as t (t.id)}
        <button
          type="button"
          class={[
            'flex items-center gap-1 border-b-2 px-3 py-1 text-xs transition-colors',
            tab === t.id
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          ]}
          onclick={() => (tab = t.id)}
          aria-pressed={tab === t.id}
        >
          <span>{t.label}</span>
          <span class="text-muted-foreground/80">{t.count}</span>
        </button>
      {/each}
    </div>
    {#if tab === 'active' && unsentInActive.length > 0}
      {@const count = unsentInActive.length}
      <div class="flex items-center gap-1 pr-1.5">
        <Button
          variant="default"
          size="xs"
          onclick={() => void sendAllUnsent()}
          disabled={sendingAll}
          aria-label="Send all unsent comments"
          title="Send all"
        >
          {#if sendingAll && !preambleOpen}
            <Loader2 class="size-3 animate-spin" />
          {:else}
            <Send class="size-3" />
          {/if}
          <span>Send all ({count})</span>
        </Button>
        <Popover.Root bind:open={preambleOpen}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="outline"
                size="icon-xs"
                aria-label="Send with optional message"
                title="Send with a message"
              >
                <MessageSquarePlus class="size-3" />
              </Button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content align="end" sideOffset={6} class="w-80 p-2">
            <div class="flex flex-col gap-1.5">
              <Textarea
                bind:value={preambleText}
                placeholder={count === 1
                  ? 'Message to send with this comment… (Enter to send, Shift+Enter for newline)'
                  : `Message to send with these ${count} comments… (Enter to send, Shift+Enter for newline)`}
                rows={3}
                disabled={sendingAll}
                aria-label="Message to accompany unsent comments"
                onkeydown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    void sendAllUnsent(preambleText);
                  }
                }}
                class="min-h-[4rem] resize-none rounded-md font-mono text-xs leading-snug"
              />
              <div class="flex items-center justify-end">
                <Button
                  variant="default"
                  size="xs"
                  onclick={() => void sendAllUnsent(preambleText)}
                  disabled={sendingAll || !preambleText.trim()}
                  aria-label="Send all with message"
                  title="Send (Enter)"
                >
                  {#if sendingAll && preambleOpen}
                    <Loader2 class="size-3 animate-spin" />
                  {:else}
                    <Send class="size-3" />
                  {/if}
                  <span>Send all ({count})</span>
                </Button>
              </div>
            </div>
          </Popover.Content>
        </Popover.Root>
      </div>
    {/if}
  </div>

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
              class="sticky top-0 z-10 flex items-center gap-1 border-b border-border/60 bg-background/95 px-1 py-1 text-left text-[10px] font-medium tracking-wider text-muted-foreground uppercase backdrop-blur-sm hover:text-foreground"
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
              {@const kinds = anchorKinds(c)}
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
                    <span class="truncate">{lineLabel(c)}</span>
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
                  {@const firstKind = kinds[0] ?? 'context'}
                  {@const firstLine = c.anchor.text[0] ?? ''}
                  {@const moreCount = c.anchor.text.length - 1}
                  {@const hasMore =
                    moreCount > 0 ||
                    c.anchor.contextBefore.length > 0 ||
                    c.anchor.contextAfter.length > 0}
                  <div
                    class="relative overflow-hidden rounded border border-dashed border-border/60 bg-background/40 font-mono text-[10px] leading-snug"
                    title={tab === 'outdated'
                      ? 'Original line content at the time the comment was made'
                      : 'Anchored line content'}
                  >
                    {#if !expanded}
                      <div
                        class={[
                          'flex items-center gap-1 overflow-hidden px-1.5 py-1',
                          hasMore ? 'pr-6' : '',
                          lineBg(firstKind)
                        ]}
                      >
                        <span
                          class={[
                            'w-3 shrink-0 select-none text-center',
                            linePrefixColor(firstKind)
                          ]}>{linePrefixChar(firstKind)}</span
                        >
                        <span class="min-w-0 flex-1 truncate text-foreground/85"
                          >{firstLine || '(empty line)'}</span
                        >
                        {#if moreCount > 0}
                          <span class="shrink-0 text-muted-foreground/60">+{moreCount}</span>
                        {/if}
                      </div>
                    {:else}
                      {#if c.anchor.contextBefore.length > 0}
                        {#each c.anchor.contextBefore as line, i (i)}
                          <div class="flex gap-1 px-1.5 text-muted-foreground/60">
                            <span
                              class="w-3 shrink-0 select-none text-center text-muted-foreground/30"
                              >&nbsp;</span
                            >
                            <span class="min-w-0 flex-1 break-all whitespace-pre-wrap"
                              >{line || ' '}</span
                            >
                          </div>
                        {/each}
                      {/if}
                      {#each c.anchor.text as line, i (i)}
                        {@const kind = kinds[i] ?? 'context'}
                        <div class={['flex gap-1 px-1.5 text-foreground/85', lineBg(kind)]}>
                          <span
                            class={[
                              'w-3 shrink-0 select-none text-center',
                              linePrefixColor(kind)
                            ]}>{linePrefixChar(kind)}</span
                          >
                          <span class="min-w-0 flex-1 break-all whitespace-pre-wrap"
                            >{line || ' '}</span
                          >
                        </div>
                      {/each}
                      {#if c.anchor.contextAfter.length > 0}
                        {#each c.anchor.contextAfter as line, i (i)}
                          <div class="flex gap-1 px-1.5 text-muted-foreground/60">
                            <span
                              class="w-3 shrink-0 select-none text-center text-muted-foreground/30"
                              >&nbsp;</span
                            >
                            <span class="min-w-0 flex-1 break-all whitespace-pre-wrap"
                              >{line || ' '}</span
                            >
                          </div>
                        {/each}
                      {/if}
                    {/if}
                    {#if hasMore}
                      <button
                        type="button"
                        class="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded bg-muted/70 text-muted-foreground/80 hover:bg-muted hover:text-foreground"
                        onclick={() => toggleExpanded(c.id)}
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Collapse anchor preview' : 'Expand anchor preview'}
                        title={expanded ? 'Collapse' : 'Show full content with context'}
                      >
                        {#if expanded}
                          <ChevronDown class="size-3" />
                        {:else}
                          <ChevronRight class="size-3" />
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
