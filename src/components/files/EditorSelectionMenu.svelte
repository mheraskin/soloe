<script lang="ts">
  import { Send } from '@lucide/svelte';
  import { EditorView } from '@codemirror/view';
  import AskAgentPopover from '../ask-agent/AskAgentPopover.svelte';

  interface Props {
    relativePath: string;
    rootEl: HTMLElement | null;
  }

  let { relativePath, rootEl }: Props = $props();

  type Anchor = {
    startLine: number;
    endLine: number;
    selectedText: string;
    top: number;
    left: number;
  };

  let anchor = $state<Anchor | null>(null);
  let popupOpen = $state(false);
  let popupSelection = $state<{ text: string; rangeLabel: string } | null>(null);
  let buttonEl: HTMLButtonElement | null = $state(null);

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

    const buttonW = 112;
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
    if (popupOpen) return;
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

  function openPopup(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const a = anchor;
    if (!a) return;
    const rangeLabel = a.startLine === a.endLine ? `L${a.startLine}` : `L${a.startLine}–${a.endLine}`;
    popupSelection = { text: a.selectedText, rangeLabel };
    popupOpen = true;
    // Keep the button rendered (so bits-ui has a stable anchor element) but
    // clear `anchor` after one tick so the chip no longer reacts to fresh
    // selection changes while the popover is open.
  }

  function onOpenChange(next: boolean): void {
    popupOpen = next;
    if (!next) {
      popupSelection = null;
      anchor = null;
      // Drop the lingering selection so opening the popover a second time
      // requires a fresh user selection (matches the comment-popover flow).
      window.getSelection()?.removeAllRanges();
    }
  }

  let contextLabel = $derived(popupSelection ? `${relativePath} (${popupSelection.rangeLabel})` : relativePath);
</script>

{#if anchor || popupOpen}
  <button
    bind:this={buttonEl}
    type="button"
    class="mobile-selection-menu fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
    style:top="{anchor?.top ?? 0}px"
    style:left="{anchor?.left ?? 0}px"
    style:visibility={anchor ? 'visible' : 'hidden'}
    onmousedown={openPopup}
    aria-label="Ask Agent about selection"
    title={anchor
      ? anchor.startLine === anchor.endLine
        ? `Ask Agent about L${anchor.startLine}`
        : `Ask Agent about L${anchor.startLine}–${anchor.endLine}`
      : 'Ask Agent'}
  >
    <Send class="size-3.5" />
    <span>Ask Agent</span>
  </button>
{/if}

{#if popupSelection}
  <AskAgentPopover
    open={popupOpen}
    onOpenChange={onOpenChange}
    selectionText={popupSelection.text}
    contextLabel={contextLabel}
    anchorEl={buttonEl}
    side="bottom"
    align="end"
  />
{/if}
