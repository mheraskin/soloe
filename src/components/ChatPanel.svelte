<script lang="ts" module>
  export interface ChatPanelMessage {
    role: 'user' | 'assistant';
    content: string;
  }

  export interface ChatPanelSendResult {
    ok: boolean;
    error?: string;
  }

  export interface ChatPanelStreamHandle {
    cancel: () => void;
  }

  export type ChatPanelSendFn = (
    message: string,
    history: ChatPanelMessage[],
    onChunk: (text: string) => void
  ) => Promise<ChatPanelSendResult> & { handle?: ChatPanelStreamHandle };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { Send, Loader2, StopCircle, Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';

  interface Props {
    send: (
      message: string,
      history: ChatPanelMessage[],
      onChunk: (text: string) => void
    ) => Promise<ChatPanelSendResult>;
    placeholder?: string;
    emptyHint?: string;
    contextSummary?: string;
    onCancel?: () => void;
    disabled?: boolean;
    history?: ChatPanelMessage[];
    onHistoryChange?: (history: ChatPanelMessage[]) => void;
  }

  let {
    send,
    placeholder = 'Ask a follow-up…',
    emptyHint = '',
    contextSummary = '',
    onCancel,
    disabled = false,
    history = $bindable([]),
    onHistoryChange
  }: Props = $props();

  let input = $state('');
  let pending = $state(false);
  let scrollEl: HTMLDivElement | null = $state(null);
  let assistantStreamingIdx = $state<number | null>(null);

  function attachScroll(el: HTMLDivElement) {
    scrollEl = el;
    return () => {
      scrollEl = null;
    };
  }

  function setHistory(next: ChatPanelMessage[]) {
    history = next;
    onHistoryChange?.(next);
  }

  async function scrollBottom() {
    await tick();
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || pending || disabled) return;
    const userMsg: ChatPanelMessage = { role: 'user', content: text };
    const priorHistory = history;
    const nextHistory = [...priorHistory, userMsg, { role: 'assistant', content: '' } as ChatPanelMessage];
    setHistory(nextHistory);
    assistantStreamingIdx = nextHistory.length - 1;
    input = '';
    pending = true;
    await scrollBottom();

    const onChunk = (chunk: string) => {
      const idx = assistantStreamingIdx;
      if (idx === null) return;
      const current = history[idx];
      if (!current) return;
      const updated = [...history];
      updated[idx] = { role: 'assistant', content: current.content + chunk };
      setHistory(updated);
      void scrollBottom();
    };

    try {
      const result = await send(text, priorHistory, onChunk);
      if (!result.ok) {
        const idx = assistantStreamingIdx;
        if (idx !== null) {
          const updated = [...history];
          updated[idx] = {
            role: 'assistant',
            content: `_Error: ${result.error ?? 'unknown'}_`
          };
          setHistory(updated);
        }
      }
    } catch (err) {
      const idx = assistantStreamingIdx;
      if (idx !== null) {
        const updated = [...history];
        updated[idx] = {
          role: 'assistant',
          content: `_Error: ${err instanceof Error ? err.message : String(err)}_`
        };
        setHistory(updated);
      }
    } finally {
      pending = false;
      assistantStreamingIdx = null;
      await scrollBottom();
    }
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  function handleClear() {
    if (pending) return;
    setHistory([]);
  }

  function handleCancel() {
    onCancel?.();
    pending = false;
    assistantStreamingIdx = null;
  }
</script>

<div class="flex h-full flex-col">
  <div {@attach attachScroll} class="flex-1 overflow-y-auto px-3 py-2">
    {#if history.length === 0}
      <div class="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
        {#if emptyHint}
          <p class="max-w-sm">{emptyHint}</p>
        {/if}
        {#if contextSummary}
          <p class="mt-2 text-xs">{contextSummary}</p>
        {/if}
      </div>
    {:else}
      <ul class="flex flex-col gap-3">
        {#each history as msg, i (i)}
          <li
            class={[
              'rounded-md border px-3 py-2 text-sm whitespace-pre-wrap',
              msg.role === 'user'
                ? 'border-border bg-accent/40'
                : 'border-border/60 bg-card'
            ]}
          >
            <div class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {msg.role === 'user' ? 'You' : 'Assistant'}
              {#if pending && assistantStreamingIdx === i}
                <span class="ml-1 inline-flex items-center gap-1">
                  <Loader2 class="h-3 w-3 animate-spin" />
                  <span>streaming…</span>
                </span>
              {/if}
            </div>
            {msg.content || (pending && assistantStreamingIdx === i ? '…' : '')}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="border-t border-border bg-card/40 p-2">
    <div class="flex items-end gap-2">
      <Textarea
        bind:value={input}
        {placeholder}
        rows={2}
        class="min-h-[2.5rem] resize-none"
        disabled={pending || disabled}
        onkeydown={handleKey}
      />
      {#if pending}
        <Button variant="outline" size="icon" onclick={handleCancel} aria-label="Cancel">
          <StopCircle class="h-4 w-4" />
        </Button>
      {:else}
        <Button
          size="icon"
          disabled={!input.trim() || disabled}
          onclick={() => void handleSend()}
          aria-label="Send"
        >
          <Send class="h-4 w-4" />
        </Button>
      {/if}
      <Button
        variant="ghost"
        size="icon"
        disabled={pending || history.length === 0}
        onclick={handleClear}
        aria-label="Clear conversation"
      >
        <Trash2 class="h-4 w-4" />
      </Button>
    </div>
  </div>
</div>
