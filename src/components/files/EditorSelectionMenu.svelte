<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowLeftToLine, Loader2, Send, X } from '@lucide/svelte';
  import { EditorView } from '@codemirror/view';
  import { Button } from '$lib/components/ui/button';
  import { ipc } from '../../lib/ipc';
  import { sessions } from '../../stores/sessions.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { reportError } from '../../stores/toast.svelte';

  interface Props {
    relativePath: string;
    rootEl: HTMLElement | null;
  }

  let { relativePath, rootEl }: Props = $props();

  // Bracketed paste protocol — same envelope the notes tab and comment sender
  // use; CR suffix turns "paste" into "paste + submit" for agents that read
  // a single bracketed chunk as one user turn.
  const PASTE_START = '\x1b[200~';
  const PASTE_END = '\x1b[201~';

  type Anchor = {
    startLine: number;
    endLine: number;
    selectedText: string;
    top: number;
    left: number;
  };

  type Popup = {
    startLine: number;
    endLine: number;
    selectedText: string;
    top: number;
    left: number;
  };

  let anchor = $state<Anchor | null>(null);
  let popup = $state<Popup | null>(null);
  let prompt = $state('');
  let sending = $state(false);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  let activeTerminalId = $derived.by<string | null>(() => {
    const sel = sessions.selected;
    if (!sel) return null;
    return sessions.terminalIdFor(sel.id);
  });

  function findEditorView(): EditorView | null {
    const root = rootEl;
    if (!root) return null;
    const cm = root.querySelector<HTMLElement>('.cm-editor');
    if (!cm) return null;
    return EditorView.findFromDOM(cm) ?? null;
  }

  function compute(): Anchor | null {
    const root = rootEl;
    if (!root) return null;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;

    const view = findEditorView();
    if (!view) return null;

    const main = view.state.selection.main;
    if (main.empty) return null;

    const from = Math.min(main.from, main.to);
    const to = Math.max(main.from, main.to);
    const startLine = view.state.doc.lineAt(from).number;
    const endLine = view.state.doc.lineAt(to).number;
    const selectedText = view.state.sliceDoc(from, to);
    if (selectedText.trim().length === 0) return null;

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    const buttonW = 132;
    const buttonH = 28;
    const margin = 8;
    let top = rect.bottom + 6;
    let left = rect.right - buttonW;

    if (top + buttonH + margin > window.innerHeight) {
      top = rect.top - buttonH - 6;
    }
    if (left < margin) left = margin;
    if (left + buttonW + margin > window.innerWidth) {
      left = window.innerWidth - buttonW - margin;
    }

    return { startLine, endLine, selectedText, top, left };
  }

  function refresh(): void {
    // Don't recompute the trigger while the popup is open — the popup owns
    // the focus and any cm-content blur would otherwise wipe the button out
    // from under it.
    if (popup) return;
    anchor = compute();
  }

  $effect(() => {
    const onSelChange = () => refresh();
    const onScroll = () => refresh();
    const onResize = () => refresh();
    document.addEventListener('selectionchange', onSelChange);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('selectionchange', onSelChange);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  });

  // Dismiss the popup on outside click or Escape. Both listeners are mounted
  // only while the popup is open so we don't intercept normal app events.
  $effect(() => {
    if (!popup) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const panel = document.querySelector<HTMLElement>('[data-soloe-editor-selection-panel="true"]');
      if (panel?.contains(target)) return;
      closePopup();
    };
    const onDocKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopup();
      }
    };
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeydown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeydown);
    };
  });

  function openPopup(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const a = anchor;
    if (!a) return;
    popup = {
      startLine: a.startLine,
      endLine: a.endLine,
      selectedText: a.selectedText,
      top: a.top,
      left: a.left
    };
    anchor = null;
    prompt = '';
    void tick().then(() => textareaEl?.focus());
  }

  function closePopup(): void {
    popup = null;
    prompt = '';
    sending = false;
  }

  function rangeLabel(p: Popup): string {
    return p.startLine === p.endLine ? `L${p.startLine}` : `L${p.startLine}–${p.endLine}`;
  }

  function buildPayload(p: Popup): string {
    const header = `${relativePath} (${rangeLabel(p)})`;
    const body = prompt.trim();
    const snippet = ['```', p.selectedText, '```'].join('\n');
    return body.length > 0 ? `${header}\n\n${snippet}\n\n${body}` : `${header}\n\n${snippet}`;
  }

  async function send(submit: boolean): Promise<void> {
    if (sending) return;
    const p = popup;
    if (!p) return;
    const id = activeTerminalId;
    if (!id) return;
    sending = true;
    // Sending hands off to the terminal — drop fullscreen so the user lands
    // back on the pane that's about to consume the input. Mirrors the comment
    // popover's behavior on Send.
    if (submit && rightRail.fullscreen) rightRail.fullscreen = false;
    try {
      const suffix = submit ? '\r' : '';
      await ipc.terminal.input(id, PASTE_START + buildPayload(p) + PASTE_END + suffix);
      window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
      closePopup();
    } catch (err) {
      reportError(err);
      sending = false;
    }
  }

  function onTextareaKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send(!e.shiftKey);
    }
  }

  let canSend = $derived(activeTerminalId !== null);
</script>

{#if anchor && !popup}
  <button
    type="button"
    class="fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
    style:top="{anchor.top}px"
    style:left="{anchor.left}px"
    onmousedown={openPopup}
    aria-label="Send selection to agent"
    title={anchor.startLine === anchor.endLine
      ? `Send L${anchor.startLine} to agent`
      : `Send L${anchor.startLine}–${anchor.endLine} to agent`}
  >
    <Send class="size-3.5" />
    <span>Send to agent</span>
  </button>
{/if}

{#if popup}
  <div
    data-soloe-editor-selection-panel="true"
    class="fixed z-50 w-80 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
    style:top="{popup.top}px"
    style:left="{popup.left}px"
  >
    <div class="mb-1 flex items-center justify-between gap-1.5">
      <span class="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={relativePath}>
        {relativePath} <span class="text-foreground/70">{rangeLabel(popup)}</span>
      </span>
      <button
        type="button"
        class="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={closePopup}
        aria-label="Close"
        title="Close"
      >
        <X class="size-3" />
      </button>
    </div>

    <pre
      class="mb-1.5 max-h-24 overflow-auto rounded-sm border border-border bg-muted/40 p-1.5 font-mono text-[10px] leading-snug whitespace-pre-wrap"
    >{popup.selectedText}</pre>

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
        title="Send (Cmd/Ctrl+Enter)"
      >
        {#if sending}
          <Loader2 class="size-3 animate-spin" />
        {:else}
          <Send class="size-3" />
        {/if}
        <span>Send</span>
      </Button>
    </div>
  </div>
{/if}
