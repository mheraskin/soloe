<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Copy, MessageSquarePlus, Scissors, ClipboardPaste, MousePointer } from '@lucide/svelte';
  import { EditorView } from '@codemirror/view';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import AskAgentPopover from '../ask-agent/AskAgentPopover.svelte';
  import { reportError } from '../../stores/toast.svelte';

  interface Props {
    relativePath: string;
    /** Element containing the `.cm-editor` — also used as the popover anchor. */
    rootEl: HTMLElement | null;
    children: Snippet;
  }

  let { relativePath, rootEl, children }: Props = $props();

  let popupOpen = $state(false);
  let popupSelection = $state<{ text: string; rangeLabel: string } | null>(null);
  // Re-read on each open so a stale selection from an earlier right-click
  // doesn't drive the menu's enabled state when the user clicks again.
  let hasSelection = $state(false);

  function findView(): EditorView | null {
    if (!rootEl) return null;
    const el = rootEl.querySelector<HTMLElement>('.cm-editor');
    return el ? (EditorView.findFromDOM(el) ?? null) : null;
  }

  function readSelection(): { from: number; to: number; text: string; rangeLabel: string } | null {
    const view = findView();
    if (!view) return null;
    const main = view.state.selection.main;
    if (main.empty) return null;
    const from = Math.min(main.from, main.to);
    const to = Math.max(main.from, main.to);
    const text = view.state.sliceDoc(from, to);
    if (text.length === 0) return null;
    const startLine = view.state.doc.lineAt(from).number;
    const endLine = view.state.doc.lineAt(to).number;
    const rangeLabel = startLine === endLine ? `L${startLine}` : `L${startLine}–${endLine}`;
    return { from, to, text, rangeLabel };
  }

  function onMenuOpenChange(open: boolean): void {
    if (open) {
      // Refresh enabled state when the menu opens — we don't track selection
      // continuously here (EditorSelectionMenu already does that for the
      // floating chip), but the menu needs to know what to grey out.
      hasSelection = readSelection() !== null;
    }
  }

  function askAgent(): void {
    const sel = readSelection();
    if (!sel) return;
    popupSelection = { text: sel.text, rangeLabel: sel.rangeLabel };
    popupOpen = true;
  }

  async function copySelection(): Promise<void> {
    const sel = readSelection();
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(sel.text);
    } catch (err) {
      reportError(err);
    }
  }

  async function cutSelection(): Promise<void> {
    const sel = readSelection();
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(sel.text);
      const view = findView();
      view?.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } });
    } catch (err) {
      reportError(err);
    }
  }

  async function pasteFromClipboard(): Promise<void> {
    const view = findView();
    if (!view) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const main = view.state.selection.main;
      view.dispatch({
        changes: { from: main.from, to: main.to, insert: text },
        selection: { anchor: main.from + text.length }
      });
    } catch (err) {
      reportError(err);
    }
  }

  function selectAll(): void {
    const view = findView();
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  }

  function onOpenChange(next: boolean): void {
    popupOpen = next;
    if (!next) popupSelection = null;
  }

  let contextLabel = $derived(popupSelection ? `${relativePath} (${popupSelection.rangeLabel})` : relativePath);
</script>

<ContextMenu.Root onOpenChange={onMenuOpenChange}>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <div {...props} class="flex min-h-0 flex-1">
        {@render children()}
      </div>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content class="w-52">
    <ContextMenu.Item disabled={!hasSelection} onclick={askAgent}>
      <MessageSquarePlus class="size-3.5" />
      Ask Agent
    </ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item disabled={!hasSelection} onclick={() => void copySelection()}>
      <Copy class="size-3.5" />
      Copy
    </ContextMenu.Item>
    <ContextMenu.Item disabled={!hasSelection} onclick={() => void cutSelection()}>
      <Scissors class="size-3.5" />
      Cut
    </ContextMenu.Item>
    <ContextMenu.Item onclick={() => void pasteFromClipboard()}>
      <ClipboardPaste class="size-3.5" />
      Paste
    </ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item onclick={selectAll}>
      <MousePointer class="size-3.5" />
      Select All
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>

{#if popupSelection}
  <AskAgentPopover
    open={popupOpen}
    onOpenChange={onOpenChange}
    selectionText={popupSelection.text}
    contextLabel={contextLabel}
    anchorEl={rootEl}
    side="bottom"
    align="end"
  />
{/if}
