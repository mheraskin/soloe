<script lang="ts">
  import { mode } from 'mode-watcher';
  import type { DiffHunk } from '@shared/types/git.js';
  import type { DiffSide } from '../../stores/diff-comments.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import { highlight, languageFor, type HighlightedLine } from '$lib/highlight.svelte';
  import CommentMarker from './CommentMarker.svelte';

  interface Props {
    hunk: DiffHunk;
    mode: 'unified' | 'split';
    gutterWidth: number;
    cwd: string;
    filePath: string;
    wrap?: boolean;
  }

  let { hunk, mode, gutterWidth, cwd, filePath, wrap = true }: Props = $props();

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

  type PairRow =
    | { kind: 'context'; old: number | null; new: number | null; text: string }
    | {
        kind: 'pair';
        old: number | null;
        new: number | null;
        oldText: string | null;
        newText: string | null;
      }
    | { kind: 'meta'; text: string };

  let pairRows = $derived.by<PairRow[]>(() => {
    const rows: PairRow[] = [];
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.kind === 'context') {
        rows.push({
          kind: 'context',
          old: line.oldLine,
          new: line.newLine,
          text: line.text
        });
        i += 1;
        continue;
      }
      if (line.kind === 'meta') {
        rows.push({ kind: 'meta', text: line.text });
        i += 1;
        continue;
      }
      const removes: typeof lines = [];
      while (i < lines.length && lines[i]!.kind === 'remove') {
        removes.push(lines[i]!);
        i += 1;
      }
      const adds: typeof lines = [];
      while (i < lines.length && lines[i]!.kind === 'add') {
        adds.push(lines[i]!);
        i += 1;
      }
      const max = Math.max(removes.length, adds.length, 1);
      for (let k = 0; k < max; k++) {
        const r = removes[k];
        const a = adds[k];
        rows.push({
          kind: 'pair',
          old: r?.oldLine ?? null,
          new: a?.newLine ?? null,
          oldText: r ? r.text : null,
          newText: a ? a.text : null
        });
      }
    }
    return rows;
  });

  function gutterStyle(width: number): string {
    return `width: ${Math.max(3, width)}ch;`;
  }

  function isSelected(side: DiffSide, line: number | null): boolean {
    if (line === null) return false;
    const sel = diffComments.selection;
    if (!sel || sel.cwd !== cwd || sel.filePath !== filePath || sel.side !== side) return false;
    return line >= sel.startLine && line <= sel.endLine;
  }

  function isInComment(side: DiffSide, line: number | null): boolean {
    if (line === null) return false;
    return diffComments.forLine(cwd, filePath, side, line).length > 0;
  }

  function commentsStartingAt(side: DiffSide, line: number | null) {
    if (line === null) return [];
    return diffComments
      .activeForFile(cwd, filePath)
      .filter((c) => c.side === side && c.startLine === line);
  }

  function gutterClass(side: DiffSide, line: number | null): string {
    const base =
      'relative shrink-0 cursor-pointer border-r border-border/60 px-1.5 text-right text-muted-foreground/70 select-none';
    if (line === null) return `${base}`;
    if (isSelected(side, line)) return `${base} bg-amber-500/30`;
    if (isInComment(side, line)) return `${base} bg-amber-500/15`;
    return base;
  }

  // Resolve a click on (preferredSide) to whichever side of the row actually
  // has a line number. Add rows have no oldLine, remove rows have no newLine —
  // clicking the empty gutter on those rows still anchors the comment to the
  // row's only existing side instead of being dead.
  function resolveTarget(
    preferredSide: DiffSide,
    oldLine: number | null,
    newLine: number | null
  ): { side: DiffSide; line: number } | null {
    const preferredLine = preferredSide === 'old' ? oldLine : newLine;
    if (preferredLine !== null) return { side: preferredSide, line: preferredLine };
    const fallbackSide: DiffSide = preferredSide === 'old' ? 'new' : 'old';
    const fallbackLine = fallbackSide === 'old' ? oldLine : newLine;
    if (fallbackLine === null) return null;
    return { side: fallbackSide, line: fallbackLine };
  }

  function onGutterMousedown(
    e: MouseEvent,
    preferredSide: DiffSide,
    oldLine: number | null,
    newLine: number | null
  ): void {
    if (e.button !== 0) return;
    const target = resolveTarget(preferredSide, oldLine, newLine);
    if (!target) return;
    e.preventDefault();
    diffComments.startSelection(cwd, filePath, target.side, target.line);
  }

  function onGutterEnter(
    preferredSide: DiffSide,
    oldLine: number | null,
    newLine: number | null
  ): void {
    // While dragging, snap to the selection's locked side so hovering either
    // gutter on a context row still extends the range.
    const sel = diffComments.selection;
    if (sel?.dragging) {
      const sideLine = sel.side === 'old' ? oldLine : newLine;
      if (sideLine !== null) {
        diffComments.extendSelection(sel.side, sideLine);
        return;
      }
    }
    const target = resolveTarget(preferredSide, oldLine, newLine);
    if (!target) return;
    diffComments.extendSelection(target.side, target.line);
  }
</script>

<section class="border-t border-border first:border-t-0">
  <header
    class="sticky top-0 z-[1] flex items-center gap-2 border-b border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
    title="@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@"
  >
    <span class="text-muted-foreground/70">
      {hunk.oldStart},{hunk.oldCount} → {hunk.newStart},{hunk.newCount}
    </span>
    {#if hunk.header}
      <span class="truncate text-muted-foreground/80">{hunk.header}</span>
    {/if}
  </header>

  <div class="flex flex-col font-mono text-[11px] leading-[1.55]">
    {#if mode === 'unified'}
      {#each hunk.lines as line, idx (idx)}
        {@const oldStarting = commentsStartingAt('old', line.oldLine)}
        {@const newStarting = commentsStartingAt('new', line.newLine)}
        {@const anchorSide = line.kind === 'remove' ? 'old' : 'new'}
        {@const anchorLine = anchorSide === 'old' ? line.oldLine : line.newLine}
        <div
          class={[
            'flex min-h-[1.45em] gap-0',
            line.kind === 'add' && 'bg-emerald-500/10 dark:bg-emerald-500/12',
            line.kind === 'remove' && 'bg-rose-500/10 dark:bg-rose-500/12',
            line.kind === 'meta' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          ]}
        >
          <span
            class={gutterClass('old', line.oldLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'old', line.oldLine, line.newLine)}
            onmouseenter={() => onGutterEnter('old', line.oldLine, line.newLine)}
            role="presentation"
          >
            {line.oldLine ?? ''}
            <CommentMarker comments={oldStarting} />
          </span>
          <span
            class={gutterClass('new', line.newLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'new', line.oldLine, line.newLine)}
            onmouseenter={() => onGutterEnter('new', line.oldLine, line.newLine)}
            role="presentation"
          >
            {line.newLine ?? ''}
            <CommentMarker comments={newStarting} />
          </span>
          <span
            class={[
              'w-5 shrink-0 select-none pl-1 text-center',
              line.kind === 'add' && 'text-emerald-600 dark:text-emerald-400',
              line.kind === 'remove' && 'text-rose-600 dark:text-rose-400',
              line.kind === 'meta' && 'text-amber-600 dark:text-amber-400'
            ]}
          >
            {#if line.kind === 'add'}+{:else if line.kind === 'remove'}−{:else if line.kind === 'meta'}~{:else}&nbsp;{/if}
          </span>
          <span
            class={textCls}
            data-diff-side={line.kind === 'meta' || anchorLine === null ? null : anchorSide}
            data-diff-line={line.kind === 'meta' || anchorLine === null ? null : anchorLine}
          >{line.text || ' '}</span>
        </div>
      {/each}
    {:else}
      {#each pairRows as row, idx (idx)}
        {#if row.kind === 'meta'}
          <div
            class="flex bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
          >
            <span class="whitespace-pre-wrap">{row.text}</span>
          </div>
        {:else}
          {@const oldStarting = commentsStartingAt('old', row.old)}
          {@const newStarting = commentsStartingAt('new', row.new)}
          <div class="grid grid-cols-2 gap-px bg-border/50">
            <div
              class={[
                'flex min-h-[1.45em] bg-background',
                row.kind === 'pair' && row.oldText !== null && 'bg-rose-500/10 dark:bg-rose-500/12'
              ]}
            >
              <span
                class={gutterClass('old', row.old)}
                style={gutterStyle(gutterWidth)}
                onmousedown={(e) => onGutterMousedown(e, 'old', row.old, row.new)}
                onmouseenter={() => onGutterEnter('old', row.old, row.new)}
                role="presentation"
              >
                {row.old ?? ''}
                <CommentMarker comments={oldStarting} />
              </span>
              <span
                class={splitTextCls}
                data-diff-side={row.old !== null ? 'old' : null}
                data-diff-line={row.old}
              >
                {#if row.kind === 'context'}
                  {row.text || ' '}
                {:else if row.oldText !== null}
                  {row.oldText || ' '}
                {/if}
              </span>
            </div>
            <div
              class={[
                'flex min-h-[1.45em] bg-background',
                row.kind === 'pair' && row.newText !== null && 'bg-emerald-500/10 dark:bg-emerald-500/12'
              ]}
            >
              <span
                class={gutterClass('new', row.new)}
                style={gutterStyle(gutterWidth)}
                onmousedown={(e) => onGutterMousedown(e, 'new', row.old, row.new)}
                onmouseenter={() => onGutterEnter('new', row.old, row.new)}
                role="presentation"
              >
                {row.new ?? ''}
                <CommentMarker comments={newStarting} />
              </span>
              <span
                class={splitTextCls}
                data-diff-side={row.new !== null ? 'new' : null}
                data-diff-line={row.new}
              >
                {#if row.kind === 'context'}
                  {row.text || ' '}
                {:else if row.newText !== null}
                  {row.newText || ' '}
                {/if}
              </span>
            </div>
          </div>
        {/if}
      {/each}
    {/if}
  </div>
</section>
