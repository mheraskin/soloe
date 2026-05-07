<script lang="ts">
  import { ChevronsUpDown, Loader2 } from '@lucide/svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { diffComments, type DiffSide } from '../../stores/diff-comments.svelte';
  import CommentMarker from './CommentMarker.svelte';

  interface Props {
    cwd: string;
    filePath: string;
    oldStart: number;
    oldEnd: number;
    newStart: number;
    gutterWidth: number;
    mode: 'unified' | 'split';
    wrap?: boolean;
  }

  let { cwd, filePath, oldStart, oldEnd, newStart, gutterWidth, mode, wrap = true }: Props = $props();

  let textCls = $derived(
    wrap
      ? 'min-w-0 grow px-1 break-all whitespace-pre-wrap'
      : 'min-w-0 grow px-1 whitespace-pre'
  );
  let splitTextCls = $derived(
    wrap
      ? 'min-w-0 grow px-1.5 break-all whitespace-pre-wrap'
      : 'min-w-0 grow px-1.5 whitespace-pre'
  );

  let entry = $derived(workingDiff.fileLinesEntry(cwd, filePath, oldStart, oldEnd));
  let gapSize = $derived(oldEnd - oldStart + 1);

  async function expand(): Promise<void> {
    await workingDiff.loadFileLines(cwd, filePath, oldStart, oldEnd);
  }

  function gutterStyle(width: number): string {
    return `width: ${Math.max(3, width)}ch;`;
  }

  function isSelected(side: DiffSide, line: number): boolean {
    const sel = diffComments.selection;
    if (!sel || sel.cwd !== cwd || sel.filePath !== filePath || sel.side !== side) return false;
    return line >= sel.startLine && line <= sel.endLine;
  }

  function isInComment(side: DiffSide, line: number): boolean {
    return diffComments.forLine(cwd, filePath, side, line).length > 0;
  }

  function commentsStartingAt(side: DiffSide, line: number) {
    return diffComments
      .activeForFile(cwd, filePath)
      .filter((c) => c.side === side && c.startLine === line);
  }

  function gutterClass(side: DiffSide, line: number): string {
    const base =
      'relative shrink-0 cursor-pointer border-r border-border/60 px-1.5 text-right text-muted-foreground/70 select-none';
    if (isSelected(side, line)) return `${base} bg-amber-500/30`;
    if (isInComment(side, line)) return `${base} bg-amber-500/15`;
    return base;
  }

  function onGutterMousedown(e: MouseEvent, side: DiffSide, line: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    diffComments.startSelection(cwd, filePath, side, line);
  }

  function onGutterEnter(side: DiffSide, line: number): void {
    diffComments.extendSelection(side, line);
  }
</script>

{#if entry.lines && entry.lines.length > 0}
  <div class="flex flex-col font-mono text-[11px] leading-[1.55]">
    {#if mode === 'unified'}
      {#each entry.lines as text, idx (idx)}
        {@const oldLine = oldStart + idx}
        {@const newLine = newStart + idx}
        <div class="flex min-h-[1.45em] gap-0">
          <span
            class={gutterClass('old', oldLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'old', oldLine)}
            onmouseenter={() => onGutterEnter('old', oldLine)}
            role="presentation"
          >
            {oldLine}
            <CommentMarker comments={commentsStartingAt('old', oldLine)} />
          </span>
          <span
            class={gutterClass('new', newLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'new', newLine)}
            onmouseenter={() => onGutterEnter('new', newLine)}
            role="presentation"
          >
            {newLine}
            <CommentMarker comments={commentsStartingAt('new', newLine)} />
          </span>
          <span class="w-5 shrink-0 pl-1 text-center select-none">&nbsp;</span>
          <span class={textCls} data-diff-side="new" data-diff-line={newLine}
            >{text || ' '}</span>
        </div>
      {/each}
    {:else}
      {#each entry.lines as text, idx (idx)}
        {@const oldLine = oldStart + idx}
        {@const newLine = newStart + idx}
        <div class="grid grid-cols-2 gap-px bg-border/50">
          <div class="flex min-h-[1.45em] bg-background">
            <span
              class={gutterClass('old', oldLine)}
              style={gutterStyle(gutterWidth)}
              onmousedown={(e) => onGutterMousedown(e, 'old', oldLine)}
              onmouseenter={() => onGutterEnter('old', oldLine)}
              role="presentation"
            >
              {oldLine}
              <CommentMarker comments={commentsStartingAt('old', oldLine)} />
            </span>
            <span class={splitTextCls} data-diff-side="old" data-diff-line={oldLine}
              >{text || ' '}</span>
          </div>
          <div class="flex min-h-[1.45em] bg-background">
            <span
              class={gutterClass('new', newLine)}
              style={gutterStyle(gutterWidth)}
              onmousedown={(e) => onGutterMousedown(e, 'new', newLine)}
              onmouseenter={() => onGutterEnter('new', newLine)}
              role="presentation"
            >
              {newLine}
              <CommentMarker comments={commentsStartingAt('new', newLine)} />
            </span>
            <span class={splitTextCls} data-diff-side="new" data-diff-line={newLine}
              >{text || ' '}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
{:else}
  <button
    type="button"
    class="flex w-full items-center justify-center gap-1.5 border-y border-border bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
    onclick={() => void expand()}
    disabled={entry.loading}
    title={entry.error ?? `Show lines ${oldStart}–${oldEnd}`}
  >
    {#if entry.loading}
      <Loader2 class="size-3 animate-spin" />
    {:else}
      <ChevronsUpDown class="size-3" />
    {/if}
    <span>
      {#if entry.error}
        {entry.error}
      {:else}
        Show {gapSize} hidden line{gapSize === 1 ? '' : 's'}
      {/if}
    </span>
  </button>
{/if}
