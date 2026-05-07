<script lang="ts">
  import { MessageSquarePlus } from '@lucide/svelte';
  import { diffComments, type DiffSide } from '../../stores/diff-comments.svelte';

  interface Props {
    cwd: string;
    filePath: string;
    rootEl: HTMLElement | null;
  }

  let { cwd, filePath, rootEl }: Props = $props();

  type Anchor = {
    side: DiffSide;
    startLine: number;
    endLine: number;
    top: number;
    left: number;
  };

  let anchor = $state<Anchor | null>(null);

  function climbToAnchor(node: Node | null): HTMLElement | null {
    let n: Node | null = node;
    while (n && n.nodeType !== Node.ELEMENT_NODE) n = n.parentNode;
    let el = n as HTMLElement | null;
    while (el && !el.hasAttribute('data-diff-line')) el = el.parentElement;
    return el;
  }

  function compute(): Anchor | null {
    const root = rootEl;
    if (!root) return null;
    if (diffComments.selection?.dragging) return null;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;

    const startEl = climbToAnchor(range.startContainer);
    const endEl = climbToAnchor(range.endContainer);
    const ref = startEl ?? endEl;
    if (!ref) return null;

    const side = ref.getAttribute('data-diff-side') as DiffSide | null;
    if (side !== 'old' && side !== 'new') return null;

    const refLine = Number(ref.getAttribute('data-diff-line'));
    if (!Number.isFinite(refLine)) return null;

    let startLine = refLine;
    let endLine = refLine;

    if (endEl && endEl !== ref) {
      const endSide = endEl.getAttribute('data-diff-side');
      const endLineN = Number(endEl.getAttribute('data-diff-line'));
      if (endSide === side && Number.isFinite(endLineN)) {
        startLine = Math.min(refLine, endLineN);
        endLine = Math.max(refLine, endLineN);
      }
    }

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

    return { side, startLine, endLine, top, left };
  }

  function refresh(): void {
    anchor = compute();
  }

  $effect(() => {
    const onChange = () => refresh();
    document.addEventListener('selectionchange', onChange);
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  });

  function commitFromSelection(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const a = anchor;
    if (!a) return;
    diffComments.startSelection(cwd, filePath, a.side, a.startLine);
    diffComments.extendSelection(a.side, a.endLine);
    diffComments.endSelectionAndCreate();
    window.getSelection()?.removeAllRanges();
    anchor = null;
  }
</script>

{#if anchor}
  <button
    type="button"
    class="fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
    style:top="{anchor.top}px"
    style:left="{anchor.left}px"
    onmousedown={commitFromSelection}
    aria-label="Add comment on selection"
    title={anchor.side === 'old'
      ? `Comment on old L${anchor.startLine}-${anchor.endLine}`
      : `Comment on new L${anchor.startLine}-${anchor.endLine}`}
  >
    <MessageSquarePlus class="size-3.5" />
    <span>Add comment</span>
  </button>
{/if}
