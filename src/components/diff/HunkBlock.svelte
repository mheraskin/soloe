<script lang="ts">
  import type { DiffHunk } from '@shared/types/git.js';
  import type { DiffSide } from '../../stores/diff-comments.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { highlightLine, languageForPath } from '$lib/highlight';
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

  let language = $derived(languageForPath(filePath));
  let fontSize = $derived(settings.current.diff.fontSize);
  let bodyStyle = $derived(`font-size: ${fontSize}px;`);

  function renderLine(text: string, kind: 'context' | 'add' | 'remove' | 'meta'): string {
    if (!text) return '&nbsp;';
    if (kind === 'meta') return escapeText(text);
    return highlightLine(text, language);
  }

  function escapeText(s: string): string {
    return s.replace(/[&<>]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
    );
  }

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
    // Box-sizing is border-box, so plain `min-width: Nch` includes the px-2
    // padding + border-r inside that floor. An empty gutter would then stop
    // at the floor while a populated one grows past it, leaving the new-line
    // column drifting left on add-only rows. Adding the 17px back keeps
    // every gutter the same width regardless of whether it has content.
    return `min-width: calc(${Math.max(3, width)}ch + 17px);`;
  }

  function isSelected(side: DiffSide, line: number | null): boolean {
    if (line === null) return false;
    const sel = diffComments.selection;
    if (!sel || sel.cwd !== cwd || sel.filePath !== filePath || sel.side !== side) return false;
    return line >= sel.startLine && line <= sel.endLine;
  }

  function commentsStartingAt(side: DiffSide, line: number | null) {
    if (line === null) return [];
    return diffComments
      .activeForFile(cwd, filePath)
      .filter((c) => c.side === side && c.startLine === line);
  }

  function commentsContinuingAt(side: DiffSide, line: number | null) {
    if (line === null) return [];
    return diffComments
      .activeForFile(cwd, filePath)
      .filter((c) => c.side === side && c.startLine < line && line <= c.endLine);
  }

  function gutterClass(side: DiffSide, oldLine: number | null, newLine: number | null): string {
    const base =
      'relative shrink-0 cursor-pointer border-r border-border/60 px-2 text-right text-muted-foreground/70 select-none';
    const lineForSide = side === 'old' ? oldLine : newLine;
    if (lineForSide === null) return base;
    const isContext = oldLine !== null && newLine !== null;
    const otherSide: DiffSide = side === 'old' ? 'new' : 'old';
    const otherLine = otherSide === 'old' ? oldLine : newLine;
    if (
      isSelected(side, lineForSide) ||
      (isContext && isSelected(otherSide, otherLine))
    ) {
      return `${base} bg-amber-500/30`;
    }
    // No background tint for in-comment rows — the vertical bar now spans
    // every covered row, so the bg tint would just duplicate the signal.
    return `${base} group-hover/diffrow:bg-amber-500/10`;
  }

  // Resolve a click on (preferredSide) to whichever side of the row actually
  // has a line number. Context rows always anchor to side='new' so we only
  // memorize one canonical coordinate (the new-file position). Add/remove
  // rows have only one side; clicking the empty gutter falls through to the
  // existing side instead of being dead.
  function resolveTarget(
    preferredSide: DiffSide,
    oldLine: number | null,
    newLine: number | null
  ): { side: DiffSide; line: number } | null {
    if (oldLine !== null && newLine !== null) {
      return { side: 'new', line: newLine };
    }
    if (newLine !== null) return { side: 'new', line: newLine };
    if (oldLine !== null) return { side: 'old', line: oldLine };
    void preferredSide;
    return null;
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

  <div class="flex flex-col font-mono leading-[1.55]" style={bodyStyle}>
    {#if mode === 'unified'}
      {#each hunk.lines as line, idx (idx)}
        {@const oldStarting = commentsStartingAt('old', line.oldLine)}
        {@const newStarting = commentsStartingAt('new', line.newLine)}
        {@const oldContinuing = commentsContinuingAt('old', line.oldLine)}
        {@const newContinuing = commentsContinuingAt('new', line.newLine)}
        {@const anchorSide = line.kind === 'remove' ? 'old' : 'new'}
        {@const anchorLine = anchorSide === 'old' ? line.oldLine : line.newLine}
        <div
          class={[
            'group/diffrow flex min-h-[1.45em] gap-0',
            line.kind === 'add' && 'bg-emerald-500/10 dark:bg-emerald-500/12',
            line.kind === 'remove' && 'bg-rose-500/10 dark:bg-rose-500/12',
            line.kind === 'meta' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          ]}
        >
          <span
            class={gutterClass('old', line.oldLine, line.newLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'old', line.oldLine, line.newLine)}
            onmouseenter={() => onGutterEnter('old', line.oldLine, line.newLine)}
            role="presentation"
          >
            {line.oldLine ?? ''}
            <CommentMarker starting={oldStarting} continuing={oldContinuing} />
          </span>
          <span
            class={gutterClass('new', line.oldLine, line.newLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'new', line.oldLine, line.newLine)}
            onmouseenter={() => onGutterEnter('new', line.oldLine, line.newLine)}
            role="presentation"
          >
            {line.newLine ?? ''}
            <CommentMarker starting={newStarting} continuing={newContinuing} />
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
          >{@html renderLine(line.text, line.kind)}</span>
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
          {@const isContext = row.kind === 'context'}
          {@const oldAnchorSide = isContext ? 'new' : 'old'}
          {@const oldAnchorLine = isContext ? row.new : row.old}
          {@const oldStarting = commentsStartingAt('old', row.old)}
          {@const newStarting = commentsStartingAt('new', row.new)}
          {@const oldContinuing = commentsContinuingAt('old', row.old)}
          {@const newContinuing = commentsContinuingAt('new', row.new)}
          <div class="group/diffrow grid grid-cols-2 gap-px bg-border/50">
            <div
              class={[
                'flex min-h-[1.45em] bg-background',
                row.kind === 'pair' && row.oldText !== null && 'bg-rose-500/10 dark:bg-rose-500/12'
              ]}
            >
              <span
                class={gutterClass('old', row.old, row.new)}
                style={gutterStyle(gutterWidth)}
                onmousedown={(e) => onGutterMousedown(e, 'old', row.old, row.new)}
                onmouseenter={() => onGutterEnter('old', row.old, row.new)}
                role="presentation"
              >
                {row.old ?? ''}
                <CommentMarker starting={oldStarting} continuing={oldContinuing} />
              </span>
              <span
                class={splitTextCls}
                data-diff-side={oldAnchorLine !== null ? oldAnchorSide : null}
                data-diff-line={oldAnchorLine}
              >
                {#if row.kind === 'context'}
                  {@html renderLine(row.text, 'context')}
                {:else if row.oldText !== null}
                  {@html renderLine(row.oldText, 'remove')}
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
                class={gutterClass('new', row.old, row.new)}
                style={gutterStyle(gutterWidth)}
                onmousedown={(e) => onGutterMousedown(e, 'new', row.old, row.new)}
                onmouseenter={() => onGutterEnter('new', row.old, row.new)}
                role="presentation"
              >
                {row.new ?? ''}
                <CommentMarker starting={newStarting} continuing={newContinuing} />
              </span>
              <span
                class={splitTextCls}
                data-diff-side={row.new !== null ? 'new' : null}
                data-diff-line={row.new}
              >
                {#if row.kind === 'context'}
                  {@html renderLine(row.text, 'context')}
                {:else if row.newText !== null}
                  {@html renderLine(row.newText, 'add')}
                {/if}
              </span>
            </div>
          </div>
        {/if}
      {/each}
    {/if}
  </div>
</section>
