<script lang="ts">
  import { MessageSquarePlus } from '@lucide/svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import {
    computeDiffSelectionAnchor,
    type DiffSelectionAnchor,
    type ReviewSelectionTarget
  } from '../../lib/diff-selection';

  interface Props {
    rootEl: HTMLElement | null;
    active: boolean;
    contextKey: string;
    geometryVersion: string;
    resolveTarget: (entryId: string) => ReviewSelectionTarget | null;
  }

  let { rootEl, active, contextKey, geometryVersion, resolveTarget }: Props = $props();
  let anchor = $state<DiffSelectionAnchor | null>(null);
  let anchorContextKey: string | null = null;

  function compute(): DiffSelectionAnchor | null {
    const root = rootEl;
    if (!root) return null;
    if (diffComments.selection?.dragging) return null;
    try {
      return computeDiffSelectionAnchor(root, window.getSelection(), {
        width: window.innerWidth,
        height: window.innerHeight
      });
    } catch {
      return null;
    }
  }

  function refresh(key = contextKey): void {
    if (!active) {
      anchor = null;
      anchorContextKey = null;
      return;
    }
    anchor = compute();
    anchorContextKey = anchor ? key : null;
  }

  $effect(() => {
    const enabled = active;
    const key = contextKey;
    const root = rootEl;
    anchor = null;
    anchorContextKey = null;
    if (!enabled || !root) return;
    const onChange = () => refresh(key);
    document.addEventListener('selectionchange', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
    };
  });

  $effect(() => {
    geometryVersion;
    if (active) refresh(contextKey);
  });

  function preserveSelection(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
  }

  function commitFromSelection(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const a = anchor;
    if (!a || anchorContextKey !== contextKey) {
      anchor = null;
      anchorContextKey = null;
      return;
    }
    const target = resolveTarget(a.entryId);
    if (!target) {
      anchor = null;
      anchorContextKey = null;
      return;
    }
    diffComments.startSelection(
      target.scope,
      target.filePath,
      a.side,
      a.startLine,
      target.section
    );
    diffComments.extendSelection(a.side, a.endLine);
    diffComments.endSelectionAndCreate(target.diff);
    window.getSelection()?.removeAllRanges();
    anchor = null;
    anchorContextKey = null;
  }
</script>

{#if anchor}
  <button
    type="button"
    class="mobile-selection-menu fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
    style:top="{anchor.top}px"
    style:left="{anchor.left}px"
    onpointerdown={preserveSelection}
    onclick={commitFromSelection}
    aria-label="Add comment on selection"
    title={anchor.side === 'old'
      ? `Comment on old L${anchor.startLine}-${anchor.endLine}`
      : `Comment on new L${anchor.startLine}-${anchor.endLine}`}
  >
    <MessageSquarePlus class="size-3.5" />
    <span>Add comment</span>
  </button>
{/if}
