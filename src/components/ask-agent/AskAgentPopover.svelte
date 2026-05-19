<script lang="ts">
  import { tick } from 'svelte';
  import type { Snippet } from 'svelte';
  import { ArrowLeftToLine, Loader2, Send, X } from '@lucide/svelte';
  import * as Popover from '$lib/components/ui/popover';
  import { Button } from '$lib/components/ui/button';
  import { sessions } from '../../stores/sessions.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { sendBracketedPaste } from '../../lib/terminal-paste';

  interface Props {
    open: boolean;
    onOpenChange: (next: boolean) => void;
    /** The text the user actually selected — pasted into the terminal verbatim. */
    selectionText: string;
    /** Optional context shown above the prompt (e.g. file path + line range). */
    contextLabel?: string;
    /** Optional trigger snippet so callers can attach an anchor element. */
    trigger?: Snippet<[{ props: Record<string, unknown> }]>;
    /** Optional anchor element — Popover.Content positions relative to it
     *  when no `trigger` snippet is provided (e.g. floating-button flow). */
    anchorEl?: HTMLElement | null;
    /** Hint for the side of the anchor on which to render (default: top). */
    side?: 'top' | 'right' | 'bottom' | 'left';
    align?: 'start' | 'center' | 'end';
  }

  let {
    open,
    onOpenChange,
    selectionText,
    contextLabel,
    trigger,
    anchorEl = null,
    side = 'top',
    align = 'start'
  }: Props = $props();

  let prompt = $state('');
  let sending = $state(false);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  let activeTerminalId = $derived.by<string | null>(() => {
    const sel = sessions.selected;
    if (!sel) return null;
    return sessions.terminalIdFor(sel.id);
  });
  let canSend = $derived(activeTerminalId !== null);

  // Reset draft and focus the textarea each time the popover opens. The
  // microtask defer waits for bits-ui's portal to mount the textarea before
  // we try to focus it.
  $effect(() => {
    if (!open) return;
    prompt = '';
    sending = false;
    void tick().then(() => textareaEl?.focus());
  });

  function buildPayload(): string {
    const body = prompt.trim();
    const snippet = ['```', selectionText, '```'].join('\n');
    const head = contextLabel ? `${contextLabel}\n\n` : '';
    return body.length > 0 ? `${head}${snippet}\n\n${body}` : `${head}${snippet}`;
  }

  async function send(submit: boolean): Promise<void> {
    if (sending) return;
    const id = activeTerminalId;
    if (!id) return;
    sending = true;
    // Submitting hands off to the agent in the terminal — drop fullscreen so
    // the user lands back on the pane that's about to consume the input.
    if (submit && rightRail.fullscreen) rightRail.fullscreen = false;
    try {
      await sendBracketedPaste(id, buildPayload(), submit);
      window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
      onOpenChange(false);
    } catch (err) {
      reportError(err);
      sending = false;
    }
  }

  function onTextareaKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onOpenChange(false);
      return;
    }
    // Enter submits; Shift+Enter inserts a newline. No draft persistence
    // here, so plain Enter can't lose any user work.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      void send(true);
    }
  }

  // When the parent passes an anchor element instead of a Popover.Trigger
  // snippet, bits-ui still requires a trigger — we render a 0-size invisible
  // one and let the parent control `open` programmatically.
  let virtualTriggerEl: HTMLDivElement | null = $state(null);

  // Mirror the caller's anchor element onto the bits-ui Popover.Trigger via
  // CSS so Popover.Content uses its rect for positioning. We don't try to
  // teleport the DOM node — bits-ui reads getBoundingClientRect on its own
  // trigger, so we just size+position our invisible trigger over the anchor.
  $effect(() => {
    const el = virtualTriggerEl;
    const target = anchorEl;
    if (!el || !target) return;
    const sync = () => {
      const rect = target.getBoundingClientRect();
      el.style.position = 'fixed';
      el.style.top = `${rect.top}px`;
      el.style.left = `${rect.left}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      el.style.pointerEvents = 'none';
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(target);
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  });
</script>

<Popover.Root {open} onOpenChange={onOpenChange}>
  <Popover.Trigger>
    {#snippet child({ props })}
      {#if trigger}
        {@render trigger({ props })}
      {:else}
        <div bind:this={virtualTriggerEl} {...props} aria-hidden="true"></div>
      {/if}
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    {side}
    {align}
    sideOffset={6}
    class="w-80 p-0"
    onOpenAutoFocus={(e) => e.preventDefault()}
  >
    <div class="px-2 pt-1 pb-1.5">
      <div class="mb-1 flex items-center justify-between gap-1.5">
        <span class="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={contextLabel ?? ''}>
          {contextLabel ?? 'Selection'}
        </span>
        <button
          type="button"
          class="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onclick={() => onOpenChange(false)}
          aria-label="Close"
          title="Close"
        >
          <X class="size-3" />
        </button>
      </div>

      <textarea
        bind:this={textareaEl}
        bind:value={prompt}
        onkeydown={onTextareaKeydown}
        class="mb-1.5 min-h-14 w-full resize-none rounded-md border border-input bg-background p-1.5 font-mono text-[11px] leading-snug outline-none focus:border-ring"
        placeholder="Optional prompt for the agent…"
        spellcheck="false"
      ></textarea>

      <div class="flex items-center justify-end gap-1.5">
        <Button
          variant="outline"
          size="xs"
          onclick={() => void send(false)}
          disabled={sending || !canSend}
          title="Paste into the terminal without submitting"
        >
          <ArrowLeftToLine class="size-3" />
          <span>Add as context</span>
        </Button>
        <Button
          size="xs"
          onclick={() => void send(true)}
          disabled={sending || !canSend}
          title="Ask (Enter)"
        >
          {#if sending}
            <Loader2 class="size-3 animate-spin" />
          {:else}
            <Send class="size-3" />
          {/if}
          <span>Ask</span>
        </Button>
      </div>
    </div>
  </Popover.Content>
</Popover.Root>
