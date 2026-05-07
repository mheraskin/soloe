<script lang="ts">
  import type { DiffHunk } from '@shared/types/git.js';
  import type { DiffSide } from '../../stores/diff-comments.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import CommentMarker from './CommentMarker.svelte';

  interface Props {
    hunk: DiffHunk;
    mode: 'unified' | 'split';
    gutterWidth: number;
    cwd: string;
    filePath: string;
  }

  let { hunk, mode, gutterWidth, cwd, filePath }: Props = $props();

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

  function onGutterMousedown(e: MouseEvent, side: DiffSide, line: number | null): void {
    if (line === null || e.button !== 0) return;
    e.preventDefault();
    diffComments.startSelection(cwd, filePath, side, line);
  }

  function onGutterEnter(side: DiffSide, line: number | null): void {
    if (line === null) return;
    diffComments.extendSelection(side, line);
  }
</script>

<section class="border-t border-border first:border-t-0">
  <header
    class="sticky top-0 z-[1] flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
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
            onmousedown={(e) => onGutterMousedown(e, 'old', line.oldLine)}
            onmouseenter={() => onGutterEnter('old', line.oldLine)}
            role="presentation"
          >
            {line.oldLine ?? ''}
            <CommentMarker comments={oldStarting} />
          </span>
          <span
            class={gutterClass('new', line.newLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'new', line.newLine)}
            onmouseenter={() => onGutterEnter('new', line.newLine)}
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
          <span class="min-w-0 grow px-1 break-all whitespace-pre-wrap">{line.text || ' '}</span>
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
                onmousedown={(e) => onGutterMousedown(e, 'old', row.old)}
                onmouseenter={() => onGutterEnter('old', row.old)}
                role="presentation"
              >
                {row.old ?? ''}
                <CommentMarker comments={oldStarting} />
              </span>
              <span class="min-w-0 grow px-1.5 break-all whitespace-pre-wrap">
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
                onmousedown={(e) => onGutterMousedown(e, 'new', row.new)}
                onmouseenter={() => onGutterEnter('new', row.new)}
                role="presentation"
              >
                {row.new ?? ''}
                <CommentMarker comments={newStarting} />
              </span>
              <span class="min-w-0 grow px-1.5 break-all whitespace-pre-wrap">
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
