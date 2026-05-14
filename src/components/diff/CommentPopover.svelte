<script lang="ts">
  import * as Popover from '$lib/components/ui/popover';
  import { Button } from '$lib/components/ui/button';
  import {
    Trash2,
    PencilLine,
    Send,
    Loader2,
    CheckCircle2,
    CircleCheck,
    CircleDot,
    X
  } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { DiffComment } from '../../stores/diff-comments.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import {
    commentAgents,
    parseMentions,
    detectMentionAtCursor,
    type CommentAgent
  } from '../../stores/comment-agents.svelte';
  import { randomName } from '../../lib/random-name';
  import { sendComment } from '../../lib/diff-comment-sender';
  import { reportError, toasts } from '../../stores/toast.svelte';
  import MentionPicker, { buildMentionItems, type MentionItem } from './MentionPicker.svelte';
  import AgentBadge from './AgentBadge.svelte';

  interface Props {
    comment: DiffComment;
    trigger: Snippet<[{ props: Record<string, unknown> }]>;
  }

  let { comment, trigger }: Props = $props();

  let editing = $derived(diffComments.editingId === comment.id);
  let open = $state(false);
  let draft = $state('');
  let textareaEl: HTMLTextAreaElement | null = $state(null);
  let cursor = $state(0);
  let pickerActiveIdx = $state(0);

  // Keep cursor in sync with selection events on the textarea so the @-detector
  // sees the right position. Updated on input, click, keyup, and selectionchange.
  function syncCursor(): void {
    if (textareaEl) cursor = textareaEl.selectionStart;
  }

  let mentionCtx = $derived(editing ? detectMentionAtCursor(draft, cursor) : null);
  let pickerItems = $derived<MentionItem[]>(
    mentionCtx ? buildMentionItems(comment.cwd, mentionCtx.query) : []
  );
  let pickerOpen = $derived(mentionCtx !== null && pickerItems.length > 0);

  // Reset highlight when the visible item set changes.
  $effect(() => {
    void pickerItems;
    pickerActiveIdx = 0;
  });

  // When editing flips on (e.g. from a fresh selection or an Edit click in
  // view mode), force the popover open and prime the textarea draft.
  $effect(() => {
    if (editing) {
      open = true;
      draft = comment.text;
    }
  });

  // Focus the textarea once it actually exists in the DOM. The popover is
  // rendered through a portal so the element binds *after* editing flips on;
  // depending on textareaEl in a separate effect picks up the late mount.
  // Also pre-empts bits-ui's default auto-focus, which would otherwise land
  // on the first focusable child (the close button) before this runs.
  $effect(() => {
    if (!editing) return;
    if (!textareaEl) return;
    textareaEl.focus();
    if (textareaEl.value.length > 0) textareaEl.select();
    syncCursor();
  });

  function handleOpenChange(next: boolean): void {
    open = next;
    if (!next && editing) {
      // Closing the popover discards the draft — persistence requires an
      // explicit Save or Send click. Brand-new comments (never had saved
      // text) are removed entirely so the placeholder doesn't linger.
      diffComments.closeEditor();
      if (comment.text.length === 0) {
        diffComments.remove(comment.id);
      }
    }
  }

  function save(): void {
    const next = draft.trim();
    if (next !== comment.text) {
      diffComments.update(comment.id, { text: next });
    }
    diffComments.closeEditor();
    // Close the popover on save so a just-added comment doesn't linger like
    // a hover preview after the user finishes typing.
    open = false;
    pruneAgentsAfterSave();
  }

  function deleteComment(): void {
    diffComments.remove(comment.id);
    open = false;
    pruneAgentsAfterSave();
  }

  function toggleResolve(): void {
    diffComments.setResolved(comment.id, !comment.resolvedAt);
    // Resolving collapses the comment out of the gutter view; close the
    // popover so the user lands back on the diff cleanly.
    if (!comment.resolvedAt) open = false;
  }

  function startEditing(): void {
    diffComments.beginEdit(comment.id);
  }

  // Insert/replace `@<name>` at the active mention range and register the
  // chosen agent in the per-cwd registry if it isn't there yet. Active
  // sessions get adopted into the registry as agents pre-bound to the
  // session id, so stage 3's send logic can resolve them uniformly.
  function applyMention(item: MentionItem): void {
    if (!mentionCtx || !textareaEl) return;
    let resolvedName: string;
    let agent: CommentAgent | null = null;
    if (item.kind === 'agent') {
      resolvedName = item.agent.name;
      agent = item.agent;
    } else if (item.kind === 'session') {
      const existing = commentAgents.byName(comment.cwd, item.session.name);
      agent = existing
        ? existing
        : commentAgents.create({
            cwd: comment.cwd,
            name: item.session.name,
            provider: item.provider,
            model: item.session.launch.type === 'agent' ? item.session.launch.model : undefined
          });
      // Bind the agent to the session id so send-time can target it directly.
      if (agent.spawnedSessionId !== item.session.id) {
        commentAgents.update(agent.id, { spawnedSessionId: item.session.id });
        agent = commentAgents.byId(agent.id) ?? agent;
      }
      resolvedName = agent.name;
    } else {
      // new-provider or new-model: mint a fresh agent with a random handle.
      const name = commentAgents.uniqueName(comment.cwd, randomName());
      agent = commentAgents.create({
        cwd: comment.cwd,
        name,
        provider: item.provider,
        ...(item.kind === 'new-model' ? { model: item.model } : {})
      });
      resolvedName = agent.name;
    }

    const before = draft.slice(0, mentionCtx.start);
    const after = draft.slice(mentionCtx.end);
    const insertion = `@${resolvedName}`;
    const tail = after.startsWith(' ') || after.length === 0 ? '' : ' ';
    const nextDraft = `${before}${insertion}${tail}${after}`;
    const nextCursor = before.length + insertion.length + tail.length;
    draft = nextDraft;
    queueMicrotask(() => {
      if (!textareaEl) return;
      textareaEl.focus();
      textareaEl.setSelectionRange(nextCursor, nextCursor);
      cursor = nextCursor;
    });
  }

  function pruneAgentsAfterSave(): void {
    // Recollect every mention used across the worktree's comments so we don't
    // drop agents that are still referenced elsewhere.
    const all = diffComments.forWorktree(comment.cwd);
    const names = new Set<string>();
    for (const c of all) {
      for (const m of parseMentions(c.text)) names.add(m);
    }
    commentAgents.pruneUnreferenced(comment.cwd, [...names]);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        pickerActiveIdx = Math.min(pickerItems.length - 1, pickerActiveIdx + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        pickerActiveIdx = Math.max(0, pickerActiveIdx - 1);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const item = pickerItems[pickerActiveIdx];
        if (item) applyMention(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Closing the picker shouldn't also cancel the comment; nudge the
        // cursor past the `@` so the detector returns null.
        if (mentionCtx && textareaEl) {
          textareaEl.setSelectionRange(mentionCtx.start, mentionCtx.start);
          cursor = mentionCtx.start;
        }
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      // Close the popover; onOpenChange discards the draft (no auto-save).
      open = false;
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      // Enter saves the comment (primary action). Shift+Enter inserts a
      // newline. Cmd/Ctrl+Enter sends — secondary, opt-in shortcut.
      e.preventDefault();
      save();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void runSend();
    }
  }

  let lineLabel = $derived(
    comment.endLine === comment.startLine
      ? `L${comment.startLine}`
      : `L${comment.startLine}–${comment.endLine}`
  );

  // Resolved mentions for the badge strip. Names typed by hand without
  // going through the picker stay as plain text — only registry hits show.
  let resolvedAgents = $derived.by<CommentAgent[]>(() => {
    const text = editing ? draft : comment.text;
    const names = parseMentions(text);
    const out: CommentAgent[] = [];
    for (const name of names) {
      const agent = commentAgents.byName(comment.cwd, name);
      if (agent) out.push(agent);
    }
    return out;
  });

  let sending = $state(false);

  // Label stays "Send" regardless of whether mentions are resolved; the
  // underlying send-time logic still routes mention-less comments to the
  // currently-focused terminal, but the label keeps a single primary CTA.
  let sendLabel = $derived('Send');

  async function runSend(): Promise<void> {
    if (sending) return;
    sending = true;
    try {
      // Stage 3 always saves first so the persisted text matches what got
      // delivered. If we're in editing mode, save() also closes the editor.
      if (editing) save();
      const result = await sendComment(comment.id);
      if (result.delivered === 0 && result.errors.length > 0) {
        toasts.push(result.errors[0] ?? 'Send failed', 'error');
      } else if (result.delivered > 0) {
        toasts.push(
          `Sent ${result.delivered} comment${result.delivered === 1 ? '' : 's'}`,
          'info'
        );
        open = false;
      }
    } catch (err) {
      reportError(err);
    } finally {
      sending = false;
    }
  }
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  <Popover.Trigger>
    {#snippet child({ props })}
      {@render trigger({ props })}
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    side="top"
    align="start"
    sideOffset={6}
    class="w-80 p-0"
    onOpenAutoFocus={(e) => e.preventDefault()}
  >
    <div class="px-2 pt-1 pb-1.5">
      <div class="mb-1 flex items-center justify-between gap-1.5">
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="font-mono text-[10px] font-medium text-muted-foreground">{lineLabel}</span>
          {#if !editing && comment.sentAt}
            <span
              class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-emerald-700 uppercase dark:text-emerald-400"
              title={`Sent ${new Date(comment.sentAt).toLocaleString()}`}
            >
              <CheckCircle2 class="size-2.5" /> sent
            </span>
          {/if}
          {#if !editing && comment.resolvedAt}
            <span
              class="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-muted-foreground uppercase"
              title={`Resolved ${new Date(comment.resolvedAt).toLocaleString()}`}
            >
              <CircleCheck class="size-2.5" /> resolved
            </span>
          {/if}
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          {#if !editing}
            <button
              type="button"
              class="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onclick={toggleResolve}
              aria-label={comment.resolvedAt ? 'Reopen comment' : 'Resolve comment'}
              title={comment.resolvedAt ? 'Reopen' : 'Resolve'}
            >
              {#if comment.resolvedAt}
                <CircleDot class="size-3" />
              {:else}
                <CircleCheck class="size-3" />
              {/if}
            </button>
          {/if}
          <button
            type="button"
            class="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            onclick={() => (open = false)}
            aria-label="Close"
            title="Close"
          >
            <X class="size-3" />
          </button>
        </div>
      </div>

      {#if editing}
        <div class="relative">
          <textarea
            bind:this={textareaEl}
            bind:value={draft}
            onkeydown={onKeydown}
            onkeyup={syncCursor}
            oninput={syncCursor}
            onclick={syncCursor}
            onselect={syncCursor}
            class="min-h-14 w-full resize-none rounded-md border border-input bg-background p-1.5 font-mono text-[11px] leading-snug outline-none focus:border-ring"
            placeholder="Add a comment… use @ to mention"
            spellcheck="false"
          ></textarea>
          {#if pickerOpen}
            <MentionPicker
              items={pickerItems}
              activeIndex={pickerActiveIdx}
              onSelect={(i) => {
                const item = pickerItems[i];
                if (item) applyMention(item);
              }}
              onHover={(i) => (pickerActiveIdx = i)}
            />
          {/if}
        </div>
        {#if resolvedAgents.length > 0}
          <div class="mt-1 flex flex-wrap items-center gap-1">
            {#each resolvedAgents as agent (agent.id)}
              <AgentBadge name={agent.name} provider={agent.provider} model={agent.model} />
            {/each}
          </div>
        {/if}
        <div class="mt-1.5 flex items-center justify-between gap-2">
          {#if comment.text.length > 0}
            <Button
              variant="ghost"
              size="xs"
              onclick={deleteComment}
              aria-label="Delete comment"
              title="Delete"
            >
              <Trash2 class="size-3" />
            </Button>
          {:else}
            <span></span>
          {/if}
          <div class="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              onclick={() => void runSend()}
              disabled={sending || draft.trim().length === 0}
              title="Send (Cmd/Ctrl+Enter)"
            >
              {#if sending}
                <Loader2 class="size-3 animate-spin" />
              {:else}
                <Send class="size-3" />
              {/if}
              <span>{sendLabel}</span>
            </Button>
            <Button size="xs" onclick={save} disabled={sending} title="Save (Enter)">Save</Button>
          </div>
        </div>
      {:else}
        <div class="flex flex-col gap-1.5">
          <pre
            class="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-snug"
          >{comment.text || '(empty)'}</pre>
          {#if resolvedAgents.length > 0}
            <div class="flex flex-wrap items-center gap-1">
              {#each resolvedAgents as agent (agent.id)}
                <AgentBadge name={agent.name} provider={agent.provider} model={agent.model} />
              {/each}
            </div>
          {/if}
          <div class="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="xs"
              onclick={deleteComment}
              aria-label="Delete comment"
              title="Delete"
            >
              <Trash2 class="size-3" />
            </Button>
            <div class="flex items-center gap-1.5">
              <Button variant="outline" size="xs" onclick={startEditing}>
                <PencilLine class="size-3" />
                <span>Edit</span>
              </Button>
              {#if comment.text.trim().length > 0}
                <Button
                  size="xs"
                  onclick={() => void runSend()}
                  disabled={sending}
                  title={comment.sentAt ? 'Send again' : sendLabel}
                >
                  {#if sending}
                    <Loader2 class="size-3 animate-spin" />
                  {:else}
                    <Send class="size-3" />
                  {/if}
                  <span>{comment.sentAt ? 'Resend' : sendLabel}</span>
                </Button>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
  </Popover.Content>
</Popover.Root>
