<script lang="ts">
  import { untrack } from 'svelte';
  import type { BlameLine, DiffHunk, DiffLine, FileDiff } from '@shared/types/git.js';
  import type { DiffComment, DiffSide } from '../../stores/diff-comments.svelte';
  import { diffComments } from '../../stores/diff-comments.svelte';
  import {
    commentAgents,
    parseMentions,
    type CommentAgent
  } from '../../stores/comment-agents.svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { highlightLine, languageForPath } from '$lib/highlight';
  import CommentMarker from './CommentMarker.svelte';
  import AgentBadge from './AgentBadge.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    CheckCircle2,
    ChevronsUpDown,
    CircleCheck,
    CircleDot,
    Loader2,
    PencilLine
  } from '@lucide/svelte';

  interface Props {
    cwd: string;
    filePath: string;
    gapPath: string;
    diff: FileDiff;
    mode: 'unified' | 'split';
    gutterWidth: number;
    canExpand: boolean;
    wrap?: boolean;
    viewport: HTMLElement | null;
    // y-offset of this file's section within the scroll content. Default 0
    // (single-file mode); in the concatenated viewer each section reports its
    // own offset so virtualization and the sticky hunk header stay correct
    // while multiple bodies share one viewport.
    sectionTop?: number;
  }

  let {
    cwd,
    filePath,
    gapPath,
    diff,
    mode,
    gutterWidth,
    canExpand,
    wrap = true,
    viewport,
    sectionTop = 0
  }: Props = $props();

  let language = $derived(languageForPath(filePath));
  let fontSize = $derived(settings.current.diff.fontSize);
  let bodyStyle = $derived(`font-size: ${fontSize}px;`);

  // Range-mode blame state. When the active review is a base..head range,
  // surface a leftmost gutter column with a colored dot per new-side line
  // whose originating commit is in the picker selection.
  let reviewMode = $derived(workingDiff.reviewModeFor(cwd));
  let isRangeMode = $derived(reviewMode.kind === 'range');
  let blameHead = $derived(reviewMode.kind === 'range' ? reviewMode.head : null);
  let blameByLine = $derived<(BlameLine | undefined)[]>(
    isRangeMode && blameHead ? workingDiff.blameEntry(cwd, filePath, blameHead).byLine : []
  );
  let activeChipFilter = $derived(
    reviewMode.kind === 'range' ? reviewMode.chipFilter : null
  );

  // Lazy-load blame on mount + whenever the active head moves. Dedupe is in
  // the store's inflightBlames map so a parallel prefetch and this lazy fetch
  // don't double up.
  $effect(() => {
    const head = blameHead;
    if (!head) return;
    void workingDiff.loadBlame(cwd, filePath, head);
  });

  function blameFor(
    newLine: number | null
  ): { sha: string; short: string; subject: string; color: string } | null {
    if (!isRangeMode || newLine === null) return null;
    if (reviewMode.kind !== 'range') return null;
    const entry = blameByLine[newLine];
    if (!entry) return null;
    const commit = reviewMode.commits.find((c) => c.hash === entry.sha);
    if (!commit) return null;
    return {
      sha: entry.sha,
      short: commit.shortHash,
      subject: commit.subject,
      color: colorForSha(entry.sha)
    };
  }

  // FNV-1a 32-bit → HSL hue. Hue alone keeps chips visually distinct without
  // varying saturation/lightness — picking the same color twice in a 5-commit
  // review is rare, and a missed match is harmless (the SHA tooltip resolves).
  function colorForSha(sha: string): string {
    let h = 2166136261;
    for (let i = 0; i < sha.length; i += 1) {
      h ^= sha.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const hue = (h >>> 0) % 360;
    return `hsl(${hue}, 65%, 52%)`;
  }

  function onBlameChipClick(e: MouseEvent, sha: string): void {
    e.stopPropagation();
    e.preventDefault();
    if (!isRangeMode) return;
    workingDiff.setChipFilter(cwd, activeChipFilter === sha ? null : sha);
  }

  function blameTitle(short: string, subject: string): string {
    return `${short} · ${subject}`;
  }

  const BLAME_GUTTER_WIDTH_CH = 1;
  function blameGutterStyle(): string {
    return `min-width: calc(${BLAME_GUTTER_WIDTH_CH}ch + 12px);`;
  }

  type GapButtonRow = {
    kind: 'gap-button';
    oldStart: number;
    oldEnd: number;
    newStart: number;
  };
  type GapLineRow = {
    kind: 'gap-line';
    oldLine: number;
    newLine: number;
    text: string;
  };
  type HunkHeaderRow = {
    kind: 'hunk-header';
    hunkIdx: number;
    hunk: DiffHunk;
    isFirst: boolean;
  };
  type LineRow = {
    kind: 'line';
    hunkIdx: number;
    lineIdx: number;
    line: DiffLine;
  };
  type PairRow = {
    kind: 'pair';
    hunkIdx: number;
    pairIdx: number;
    old: number | null;
    new: number | null;
    oldText: string | null;
    newText: string | null;
    isContext: boolean;
  };
  type SplitMetaRow = { kind: 'split-meta'; text: string; hunkIdx: number; pairIdx: number };
  type Row = GapButtonRow | GapLineRow | HunkHeaderRow | LineRow | PairRow | SplitMetaRow;

  type PairBuilt =
    | {
        kind: 'pair';
        old: number | null;
        new: number | null;
        oldText: string | null;
        newText: string | null;
        isContext: boolean;
      }
    | { kind: 'meta'; text: string };

  function buildPairs(lines: DiffLine[]): PairBuilt[] {
    const out: PairBuilt[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.kind === 'context') {
        out.push({
          kind: 'pair',
          old: line.oldLine,
          new: line.newLine,
          oldText: line.text,
          newText: line.text,
          isContext: true
        });
        i += 1;
        continue;
      }
      if (line.kind === 'meta') {
        out.push({ kind: 'meta', text: line.text });
        i += 1;
        continue;
      }
      const removes: DiffLine[] = [];
      while (i < lines.length && lines[i]!.kind === 'remove') {
        removes.push(lines[i]!);
        i += 1;
      }
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i]!.kind === 'add') {
        adds.push(lines[i]!);
        i += 1;
      }
      const max = Math.max(removes.length, adds.length, 1);
      for (let k = 0; k < max; k++) {
        const r = removes[k];
        const a = adds[k];
        out.push({
          kind: 'pair',
          old: r?.oldLine ?? null,
          new: a?.newLine ?? null,
          oldText: r ? r.text : null,
          newText: a ? a.text : null,
          isContext: false
        });
      }
    }
    return out;
  }

  let rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    const hunks = diff.hunks;

    if (canExpand && hunks[0] && hunks[0].oldStart > 1) {
      const oldStart = 1;
      const oldEnd = hunks[0].oldStart - 1;
      const entry = workingDiff.fileLinesEntry(cwd, gapPath, oldStart, oldEnd);
      if (entry.lines && entry.lines.length > 0) {
        for (let i = 0; i < entry.lines.length; i++) {
          out.push({
            kind: 'gap-line',
            oldLine: oldStart + i,
            newLine: 1 + i,
            text: entry.lines[i] ?? ''
          });
        }
      } else {
        out.push({ kind: 'gap-button', oldStart, oldEnd, newStart: 1 });
      }
    }

    for (let hidx = 0; hidx < hunks.length; hidx++) {
      const hunk = hunks[hidx]!;
      out.push({ kind: 'hunk-header', hunkIdx: hidx, hunk, isFirst: hidx === 0 });

      if (mode === 'unified') {
        for (let lidx = 0; lidx < hunk.lines.length; lidx++) {
          out.push({ kind: 'line', hunkIdx: hidx, lineIdx: lidx, line: hunk.lines[lidx]! });
        }
      } else {
        const pairs = buildPairs(hunk.lines);
        for (let pidx = 0; pidx < pairs.length; pidx++) {
          const p = pairs[pidx]!;
          if (p.kind === 'meta') {
            out.push({ kind: 'split-meta', text: p.text, hunkIdx: hidx, pairIdx: pidx });
          } else {
            out.push({
              kind: 'pair',
              hunkIdx: hidx,
              pairIdx: pidx,
              old: p.old,
              new: p.new,
              oldText: p.oldText,
              newText: p.newText,
              isContext: p.isContext
            });
          }
        }
      }

      if (canExpand && hidx < hunks.length - 1) {
        const next = hunks[hidx + 1]!;
        const gapOldStart = hunk.oldStart + hunk.oldCount;
        const gapNewStart = hunk.newStart + hunk.newCount;
        const gapOldEnd = next.oldStart - 1;
        if (gapOldEnd >= gapOldStart) {
          const entry = workingDiff.fileLinesEntry(cwd, gapPath, gapOldStart, gapOldEnd);
          if (entry.lines && entry.lines.length > 0) {
            for (let i = 0; i < entry.lines.length; i++) {
              out.push({
                kind: 'gap-line',
                oldLine: gapOldStart + i,
                newLine: gapNewStart + i,
                text: entry.lines[i] ?? ''
              });
            }
          } else {
            out.push({
              kind: 'gap-button',
              oldStart: gapOldStart,
              oldEnd: gapOldEnd,
              newStart: gapNewStart
            });
          }
        }
      }
    }

    return out;
  });

  const ROW_PX_BASE = 18;
  const ROW_PX_BUTTON = 24;
  const ROW_PX_HEADER = 19;

  // With wrap=true a single source line can render to 2–4 visual rows; a
  // static 18px estimate underprices them and the visible-range offsets
  // thrash mid-scroll while ResizeObserver catches up. Track a running
  // last-measured value as the wrapped-row estimate so newly virtualized
  // rows land near their final position on first paint.
  let estimatedLinePx = $state(ROW_PX_BASE);

  function estimateHeight(row: Row): number {
    if (row.kind === 'gap-button') return ROW_PX_BUTTON;
    if (row.kind === 'hunk-header') return ROW_PX_HEADER;
    if (wrap && (row.kind === 'line' || row.kind === 'pair')) return estimatedLinePx;
    return ROW_PX_BASE;
  }

  // Measurements keyed by stable row identity, not array index. Indexing by
  // position breaks the moment rows shift (e.g. expanding a gap replaces a
  // gap-button at idx N with several gap-lines, pushing every subsequent row
  // down by one slot). The old measurements at those slots would then be
  // applied to entirely different rows, producing visible gaps until the
  // ResizeObserver caught up.
  function rowKey(row: Row): string {
    switch (row.kind) {
      case 'gap-button':
        return `gb:${row.oldStart}-${row.oldEnd}`;
      case 'gap-line':
        return `gl:${row.oldLine}-${row.newLine}`;
      case 'hunk-header':
        return `hh:${row.hunkIdx}`;
      case 'line':
        return `ln:${row.hunkIdx}-${row.lineIdx}`;
      case 'pair':
        return `pr:${row.hunkIdx}-${row.pairIdx}`;
      case 'split-meta':
        return `sm:${row.hunkIdx}-${row.pairIdx}`;
    }
  }

  let measured = $state<Record<string, number>>({});

  // When wrap is off, rows can extend beyond viewport. Track the widest
  // measured row so the relative container can grow and the ScrollArea sees
  // horizontal overflow. Always grows; resets on diff/mode/wrap change below.
  let maxContentWidth = $state(0);

  // Coalesce ResizeObserver-driven measurement writes into one state update
  // per frame. Mounting N virtualized rows used to fire N separate writes,
  // each cascading through heights → offsets → visibleRange → mount more
  // rows; fast scroll jittered and gutter clicks landed on rows whose y had
  // shifted mid-event. Plain `let` (not $state) so the pending buffer is
  // itself non-reactive.
  let pendingMeasured: Record<string, number> | null = null;
  let pendingMaxWidth = 0;
  let measureRaf: number | null = null;

  let heights = $derived.by<number[]>(() => {
    const arr = new Array<number>(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const m = measured[rowKey(r)];
      arr[i] = m && m > 0 ? m : estimateHeight(r);
    }
    return arr;
  });

  let offsets = $derived.by<number[]>(() => {
    const out = new Array<number>(rows.length + 1);
    out[0] = 0;
    for (let i = 0; i < rows.length; i++) {
      out[i + 1] = (out[i] ?? 0) + (heights[i] ?? ROW_PX_BASE);
    }
    return out;
  });

  let totalHeight = $derived(offsets[rows.length] ?? 0);

  let scrollTop = $state(0);
  let viewportHeight = $state(800);

  $effect(() => {
    const v = viewport;
    if (!v) return;
    const onScroll = () => {
      scrollTop = v.scrollTop;
      // Hover preview anchors to a captured rect; once the gutter scrolls
      // away the tooltip would float in the wrong place. Cheaper to drop it.
      cancelHover();
    };
    const onResize = () => {
      viewportHeight = v.clientHeight;
    };
    onResize();
    onScroll();
    v.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onResize);
    ro.observe(v);
    return () => {
      v.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  });

  // Flash-on-jump support: when the comments rail surfaces a highlight hint
  // targeting this file, scroll the first matching row into view and apply
  // a one-shot pulse class to every row inside the range. The store clears
  // the hint after ~1.6s so the class falls off automatically.
  let highlightHint = $derived.by(() => {
    const h = diffComments.highlight;
    if (!h || h.cwd !== cwd || h.filePath !== filePath) return null;
    return h;
  });

  function lineMatchesHighlight(side: DiffSide, line: number | null): boolean {
    if (line === null) return false;
    const h = highlightHint;
    if (!h || h.side !== side) return false;
    return line >= h.startLine && line <= h.endLine;
  }

  function rowMatchesHighlight(row: Row): boolean {
    const h = highlightHint;
    if (!h) return false;
    if (row.kind === 'line') {
      const ln = h.side === 'old' ? row.line.oldLine : row.line.newLine;
      return ln !== null && ln >= h.startLine && ln <= h.endLine;
    }
    if (row.kind === 'pair') {
      const ln = h.side === 'old' ? row.old : row.new;
      return ln !== null && ln >= h.startLine && ln <= h.endLine;
    }
    if (row.kind === 'gap-line') {
      const ln = h.side === 'old' ? row.oldLine : row.newLine;
      return ln >= h.startLine && ln <= h.endLine;
    }
    return false;
  }

  // Smooth-scroll into view when a comment-jump arrives. Read everything but
  // `highlightHint`/`viewport` via `untrack` — the scroll triggers measureRow
  // writes, which would otherwise re-derive `offsets`/`rows` and re-fire this
  // effect, looping until Svelte hit its update-depth limit.
  $effect(() => {
    const h = highlightHint;
    const v = viewport;
    if (!h || !v) return;
    untrack(() => {
      let idx = -1;
      for (let i = 0; i < rows.length; i++) {
        if (rowMatchesHighlight(rows[i]!)) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return;
      const localTarget = (offsets[idx] ?? 0) - Math.max(40, viewportHeight / 3);
      v.scrollTo({ top: Math.max(0, sectionTop + localTarget), behavior: 'smooth' });
    });
  });

  // Drop measured heights when the diff body, mode, wrap, or font size
  // changes — the previous measurements no longer correspond to the rows
  // we'll render.
  $effect(() => {
    void diff;
    void mode;
    void wrap;
    void fontSize;
    measured = {};
    maxContentWidth = 0;
    estimatedLinePx = ROW_PX_BASE;
    if (measureRaf !== null) {
      cancelAnimationFrame(measureRaf);
      measureRaf = null;
    }
    pendingMeasured = null;
    pendingMaxWidth = 0;
  });

  $effect(() => {
    return () => {
      if (measureRaf !== null) cancelAnimationFrame(measureRaf);
    };
  });

  function findFirstAtOrAfter(target: number): number {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((offsets[mid + 1] ?? 0) <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const BUFFER_ROWS = 8;

  let visibleRange = $derived.by(() => {
    if (!sectionActive) return { start: 0, end: 0 };
    const startIdx = findFirstAtOrAfter(localScrollTop);
    const endIdx = findFirstAtOrAfter(Math.min(totalHeight, localBottom)) + 1;
    const start = Math.max(0, startIdx - BUFFER_ROWS);
    const end = Math.min(rows.length, endIdx + BUFFER_ROWS);
    return { start, end };
  });

  let visibleItems = $derived.by(() => {
    const out: Array<{ row: Row }> = [];
    const { start, end } = visibleRange;
    for (let i = start; i < end; i++) {
      out.push({ row: rows[i]! });
    }
    return out;
  });

  // Position the entire visible block by the first row's offset and let rows
  // stack via document flow inside it. Per-row absolute `top` would let a
  // taller-than-estimated wrapped row overlap its neighbour until the
  // ResizeObserver round-trip completed; document flow rules that out.
  let visibleStartTop = $derived(offsets[visibleRange.start] ?? 0);

  // Position within this section. In single-file mode sectionTop=0 so
  // localScrollTop matches the viewport scroll directly; in multi-file the
  // viewport scrolls past earlier sections first.
  let localScrollTop = $derived(Math.max(0, scrollTop - sectionTop));
  let localBottom = $derived(scrollTop + viewportHeight - sectionTop);
  let sectionActive = $derived(localBottom > 0 && localScrollTop < totalHeight);

  // Sticky hunk header — find the latest hunk-header at or above localScrollTop,
  // plus the next one so we can push the current header up smoothly when
  // they collide.
  let sticky = $derived.by<{ hunk: DiffHunk; top: number; height: number } | null>(() => {
    if (!sectionActive) return null;
    let currentIdx = -1;
    let nextIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.kind !== 'hunk-header') continue;
      const top = offsets[i] ?? 0;
      if (top <= localScrollTop) {
        currentIdx = i;
      } else {
        nextIdx = i;
        break;
      }
    }
    if (currentIdx < 0) return null;
    const headerHeight = heights[currentIdx] ?? ROW_PX_HEADER;
    let stickyTop = localScrollTop;
    if (nextIdx >= 0) {
      const nextTop = offsets[nextIdx] ?? 0;
      const limit = nextTop - headerHeight;
      if (limit < stickyTop) stickyTop = limit;
    }
    const headerRow = rows[currentIdx] as HunkHeaderRow;
    return { hunk: headerRow.hunk, top: stickyTop, height: headerHeight };
  });

  function flushMeasurements(): void {
    measureRaf = null;
    if (pendingMeasured) {
      // Drive the wrapped-row estimate off the latest line/pair seen in
      // this batch — last-seen wins. A running average isn't worth the
      // bookkeeping; the visible window dominates and outliers self-correct
      // on the next batch.
      for (const key in pendingMeasured) {
        if (key.startsWith('ln:') || key.startsWith('pr:')) {
          const h = pendingMeasured[key]!;
          if (h > 0) estimatedLinePx = h;
        }
      }
      measured = { ...measured, ...pendingMeasured };
      pendingMeasured = null;
    }
    if (pendingMaxWidth > maxContentWidth) maxContentWidth = pendingMaxWidth;
    pendingMaxWidth = 0;
  }

  function scheduleFlush(): void {
    if (measureRaf !== null) return;
    measureRaf = requestAnimationFrame(flushMeasurements);
  }

  function measureRow(
    node: HTMLElement,
    key: string
  ): { update: (newKey: string) => void; destroy: () => void } {
    let currentKey = key;
    const update = () => {
      const h = node.offsetHeight;
      if (h > 0 && measured[currentKey] !== h && pendingMeasured?.[currentKey] !== h) {
        if (!pendingMeasured) pendingMeasured = {};
        pendingMeasured[currentKey] = h;
        scheduleFlush();
      }
      const w = node.scrollWidth;
      if (w > maxContentWidth && w > pendingMaxWidth) {
        pendingMaxWidth = w;
        scheduleFlush();
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return {
      update(newKey: string) {
        if (newKey === currentKey) return;
        currentKey = newKey;
        update();
      },
      destroy() {
        ro.disconnect();
      }
    };
  }

  function renderText(text: string, kind: 'context' | 'add' | 'remove' | 'meta'): string {
    if (!text) return '&nbsp;';
    if (kind === 'meta') return escapeText(text);
    return highlightLine(text, language);
  }

  function escapeText(s: string): string {
    return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
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

  function gutterStyle(width: number): string {
    // Box-sizing is border-box, so `min-width: Nch` includes px-2 padding +
    // border-r. An empty gutter would stop at the floor while a populated
    // one grows past it, leaving the new-line number drifting left on
    // add-only rows. Adding 17px back keeps every gutter the same width.
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
    // Highlight spans both gutter columns when *either* side has a selection
    // on this row — including add-only and remove-only rows where one side
    // has no line number. The vertical bar (CommentMarker) covers the
    // commented-row case across the whole range; no bg tint needed.
    const oldSelected = oldLine !== null && isSelected('old', oldLine);
    const newSelected = newLine !== null && isSelected('new', newLine);
    if (oldSelected || newSelected) return `${base} bg-amber-500/30`;
    void side;
    return `${base} group-hover/diffrow:bg-amber-500/10`;
  }

  // Gap rows always have both sides — clicks anchor to 'new' since context
  // comments use that as the canonical coordinate.
  function gapGutterClass(side: DiffSide, oldLine: number, newLine: number): string {
    const base =
      'relative shrink-0 cursor-pointer border-r border-border/60 px-2 text-right text-muted-foreground/70 select-none';
    if (isSelected('new', newLine) || isSelected('old', oldLine)) {
      return `${base} bg-amber-500/30`;
    }
    void side;
    return `${base} group-hover/diffrow:bg-amber-500/10`;
  }

  function resolveTarget(
    preferredSide: DiffSide,
    oldLine: number | null,
    newLine: number | null
  ): { side: DiffSide; line: number } | null {
    if (oldLine !== null && newLine !== null) return { side: 'new', line: newLine };
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
    cancelHover();
    diffComments.startSelection(cwd, filePath, target.side, target.line);
  }

  function onGutterEnter(
    preferredSide: DiffSide,
    oldLine: number | null,
    newLine: number | null
  ): void {
    const sel = diffComments.selection;
    if (sel?.dragging) {
      // Cross-file drag: extendSelection only knows side+line, so applying
      // another file's coordinates would corrupt this drag's range. Wait
      // until the cursor returns to the originating file.
      if (sel.cwd !== cwd || sel.filePath !== filePath) return;
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

  function onGapGutterMousedown(e: MouseEvent, newLine: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    cancelHover();
    diffComments.startSelection(cwd, filePath, 'new', newLine);
  }

  function onGapGutterEnter(oldLine: number, newLine: number): void {
    const sel = diffComments.selection;
    if (sel?.dragging) {
      if (sel.cwd !== cwd || sel.filePath !== filePath) return;
      diffComments.extendSelection(sel.side, sel.side === 'old' ? oldLine : newLine);
      return;
    }
    diffComments.extendSelection('new', newLine);
  }

  // Gutter hover preview — a small floating panel that lists every comment
  // covering the hovered line, opened after a short delay so quick mouse
  // passes don't flash. Anchored to the gutter span's bounding rect at the
  // moment of hover; scrolling or starting a drag cancels it.
  type HoverPreview = {
    side: DiffSide;
    line: number;
    rect: DOMRect;
    comments: DiffComment[];
  };
  let hoverPreview = $state<HoverPreview | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
  const HOVER_DELAY_MS = 180;
  // Bridge delay — gives the user time to move from the gutter into the panel
  // without the preview closing under them.
  const HOVER_CLOSE_DELAY_MS = 120;

  function clearHoverTimer(): void {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function clearHoverCloseTimer(): void {
    if (hoverCloseTimer) {
      clearTimeout(hoverCloseTimer);
      hoverCloseTimer = null;
    }
  }

  function cancelHover(): void {
    clearHoverTimer();
    clearHoverCloseTimer();
    hoverPreview = null;
  }

  // Soft-close — schedules a close after a short delay so the user can move
  // the cursor into the preview panel itself. Entering the panel cancels it.
  function softCloseHover(): void {
    clearHoverTimer();
    clearHoverCloseTimer();
    hoverCloseTimer = setTimeout(() => {
      hoverPreview = null;
      hoverCloseTimer = null;
    }, HOVER_CLOSE_DELAY_MS);
  }

  function keepHoverOpen(): void {
    clearHoverCloseTimer();
  }

  function editHoverComment(id: string): void {
    cancelHover();
    diffComments.beginEdit(id);
  }

  function toggleResolveHoverComment(c: DiffComment): void {
    diffComments.setResolved(c.id, !c.resolvedAt);
    // Refresh the preview so the badge updates without waiting for a reopen.
    if (hoverPreview) {
      const updated = diffComments.forLine(cwd, filePath, hoverPreview.side, hoverPreview.line);
      if (updated.length === 0) {
        cancelHover();
      } else {
        hoverPreview = { ...hoverPreview, comments: updated };
      }
    }
  }

  function scheduleHover(
    preferredSide: DiffSide,
    oldLine: number | null,
    newLine: number | null,
    target: EventTarget | null
  ): void {
    if (diffComments.selection?.dragging) return;
    if (diffComments.editingId !== null) return;
    const t = resolveTarget(preferredSide, oldLine, newLine);
    if (!t) {
      cancelHover();
      return;
    }
    const comments = diffComments.forLine(cwd, filePath, t.side, t.line);
    if (comments.length === 0) {
      cancelHover();
      return;
    }
    const el = target as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    clearHoverTimer();
    hoverTimer = setTimeout(() => {
      hoverPreview = { side: t.side, line: t.line, rect, comments };
      hoverTimer = null;
    }, HOVER_DELAY_MS);
  }

  function hoverAgentsFor(comment: DiffComment): CommentAgent[] {
    const out: CommentAgent[] = [];
    for (const name of parseMentions(comment.text)) {
      const agent = commentAgents.byName(comment.cwd, name);
      if (agent) out.push(agent);
    }
    return out;
  }

  function hoverRangeLabel(comment: DiffComment): string {
    return comment.endLine === comment.startLine
      ? `L${comment.startLine}`
      : `L${comment.startLine}–${comment.endLine}`;
  }

  async function expandGap(oldStart: number, oldEnd: number): Promise<void> {
    await workingDiff.loadFileLines(cwd, gapPath, oldStart, oldEnd);
  }

  function gapButtonEntry(oldStart: number, oldEnd: number) {
    return workingDiff.fileLinesEntry(cwd, gapPath, oldStart, oldEnd);
  }
</script>

{#snippet hunkHeaderRender(hunk: DiffHunk)}
  <span class="text-muted-foreground/70">
    {hunk.oldStart},{hunk.oldCount} → {hunk.newStart},{hunk.newCount}
  </span>
  {#if hunk.header}
    <span class="truncate text-muted-foreground/80">{hunk.header}</span>
  {/if}
{/snippet}

<div
  class="relative w-full"
  style:height="{totalHeight}px"
  style:min-width={!wrap && maxContentWidth > 0 ? `${maxContentWidth}px` : null}
>
  {#if sticky}
    <header
      class="absolute right-0 left-0 z-10 flex items-center gap-2 border-y border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
      style:top="{sticky.top}px"
      title="@@ -{sticky.hunk.oldStart},{sticky.hunk.oldCount} +{sticky.hunk.newStart},{sticky.hunk.newCount} @@"
    >
      {@render hunkHeaderRender(sticky.hunk)}
    </header>
  {/if}

  <div class="absolute right-0 left-0" style:top="{visibleStartTop}px">
  {#each visibleItems as item (rowKey(item.row))}
    <div use:measureRow={rowKey(item.row)}>
      {#if item.row.kind === 'hunk-header'}
        <header
          class={[
            'flex items-center gap-2 border-b border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground',
            !item.row.isFirst && 'border-t'
          ]}
          title="@@ -{item.row.hunk.oldStart},{item.row.hunk.oldCount} +{item.row.hunk.newStart},{item.row.hunk.newCount} @@"
        >
          {@render hunkHeaderRender(item.row.hunk)}
        </header>
      {:else if item.row.kind === 'line'}
        {@const line = item.row.line}
        {@const oldStarting = commentsStartingAt('old', line.oldLine)}
        {@const newStarting = commentsStartingAt('new', line.newLine)}
        {@const oldContinuing = commentsContinuingAt('old', line.oldLine)}
        {@const newContinuing = commentsContinuingAt('new', line.newLine)}
        {@const anchorSide = line.kind === 'remove' ? 'old' : 'new'}
        {@const anchorLine = anchorSide === 'old' ? line.oldLine : line.newLine}
        {@const flashing = rowMatchesHighlight(item.row)}
        {@const blame = blameFor(line.newLine)}
        <div
          style={bodyStyle}
          class={[
            'group/diffrow flex min-h-[1.45em] gap-0 font-mono leading-[1.55]',
            line.kind === 'add' && 'bg-emerald-500/10 dark:bg-emerald-500/12',
            line.kind === 'remove' && 'bg-rose-500/10 dark:bg-rose-500/12',
            line.kind === 'meta' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
            flashing && 'diff-comment-flash'
          ]}
        >
          {#if isRangeMode}
            <span
              class="relative flex shrink-0 items-center justify-center border-r border-border/60 select-none"
              style={blameGutterStyle()}
            >
              {#if blame}
                <button
                  type="button"
                  class={[
                    'h-2 w-2 rounded-full transition-transform hover:scale-125',
                    activeChipFilter === blame.sha && 'ring-1 ring-offset-1 ring-foreground/60'
                  ]}
                  style:background-color={blame.color}
                  onclick={(e) => onBlameChipClick(e, blame.sha)}
                  title={blameTitle(blame.short, blame.subject)}
                  aria-label="Filter by commit {blame.short}"
                ></button>
              {/if}
            </span>
          {/if}
          <span
            class={gutterClass('old', line.oldLine, line.newLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'old', line.oldLine, line.newLine)}
            onmouseenter={(e) => {
              onGutterEnter('old', line.oldLine, line.newLine);
              scheduleHover('old', line.oldLine, line.newLine, e.currentTarget);
            }}
            onmouseleave={softCloseHover}
            role="presentation"
          >
            {line.oldLine ?? ''}
            <CommentMarker starting={oldStarting} continuing={oldContinuing} />
          </span>
          <span
            class={gutterClass('new', line.oldLine, line.newLine)}
            style={gutterStyle(gutterWidth)}
            onmousedown={(e) => onGutterMousedown(e, 'new', line.oldLine, line.newLine)}
            onmouseenter={(e) => {
              onGutterEnter('new', line.oldLine, line.newLine);
              scheduleHover('new', line.oldLine, line.newLine, e.currentTarget);
            }}
            onmouseleave={softCloseHover}
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
          >{@html renderText(line.text, line.kind)}</span>
        </div>
      {:else if item.row.kind === 'pair'}
        {@const row = item.row}
        {@const oldStarting = commentsStartingAt('old', row.old)}
        {@const newStarting = commentsStartingAt('new', row.new)}
        {@const oldContinuing = commentsContinuingAt('old', row.old)}
        {@const newContinuing = commentsContinuingAt('new', row.new)}
        {@const oldAnchorSide = row.isContext ? 'new' : 'old'}
        {@const oldAnchorLine = row.isContext ? row.new : row.old}
        {@const flashing = rowMatchesHighlight(item.row)}
        {@const blame = blameFor(row.new)}
        <div
          class={[
            'group/diffrow flex font-mono leading-[1.55]',
            flashing && 'diff-comment-flash'
          ]}
          style={bodyStyle}
        >
          {#if isRangeMode}
            <span
              class="relative flex shrink-0 items-center justify-center border-r border-border/60 bg-background select-none"
              style={blameGutterStyle()}
            >
              {#if blame}
                <button
                  type="button"
                  class={[
                    'h-2 w-2 rounded-full transition-transform hover:scale-125',
                    activeChipFilter === blame.sha && 'ring-1 ring-offset-1 ring-foreground/60'
                  ]}
                  style:background-color={blame.color}
                  onclick={(e) => onBlameChipClick(e, blame.sha)}
                  title={blameTitle(blame.short, blame.subject)}
                  aria-label="Filter by commit {blame.short}"
                ></button>
              {/if}
            </span>
          {/if}
          <div class="grid min-w-0 grow grid-cols-2 gap-px bg-border/50">
          <div
            class={[
              'flex min-h-[1.45em] bg-background',
              !row.isContext && row.oldText !== null && 'bg-rose-500/10 dark:bg-rose-500/12'
            ]}
          >
            <span
              class={gutterClass('old', row.old, row.new)}
              style={gutterStyle(gutterWidth)}
              onmousedown={(e) => onGutterMousedown(e, 'old', row.old, row.new)}
              onmouseenter={(e) => {
                onGutterEnter('old', row.old, row.new);
                scheduleHover('old', row.old, row.new, e.currentTarget);
              }}
              onmouseleave={softCloseHover}
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
              {#if row.isContext && row.oldText !== null}
                {@html renderText(row.oldText, 'context')}
              {:else if row.oldText !== null}
                {@html renderText(row.oldText, 'remove')}
              {/if}
            </span>
          </div>
          <div
            class={[
              'flex min-h-[1.45em] bg-background',
              !row.isContext && row.newText !== null && 'bg-emerald-500/10 dark:bg-emerald-500/12'
            ]}
          >
            <span
              class={gutterClass('new', row.old, row.new)}
              style={gutterStyle(gutterWidth)}
              onmousedown={(e) => onGutterMousedown(e, 'new', row.old, row.new)}
              onmouseenter={(e) => {
                onGutterEnter('new', row.old, row.new);
                scheduleHover('new', row.old, row.new, e.currentTarget);
              }}
              onmouseleave={softCloseHover}
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
              {#if row.isContext && row.newText !== null}
                {@html renderText(row.newText, 'context')}
              {:else if row.newText !== null}
                {@html renderText(row.newText, 'add')}
              {/if}
            </span>
          </div>
          </div>
        </div>
      {:else if item.row.kind === 'split-meta'}
        <div
          class="flex bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400"
        >
          <span class="whitespace-pre-wrap">{item.row.text}</span>
        </div>
      {:else if item.row.kind === 'gap-line'}
        {@const oldLine = item.row.oldLine}
        {@const newLine = item.row.newLine}
        {@const text = item.row.text}
        {@const blame = blameFor(newLine)}
        {#if mode === 'unified'}
          <div class="group/diffrow flex min-h-[1.45em] gap-0 font-mono leading-[1.55]" style={bodyStyle}>
            {#if isRangeMode}
              <span
                class="relative flex shrink-0 items-center justify-center border-r border-border/60 select-none"
                style={blameGutterStyle()}
              >
                {#if blame}
                  <button
                    type="button"
                    class={[
                      'h-2 w-2 rounded-full transition-transform hover:scale-125',
                      activeChipFilter === blame.sha && 'ring-1 ring-offset-1 ring-foreground/60'
                    ]}
                    style:background-color={blame.color}
                    onclick={(e) => onBlameChipClick(e, blame.sha)}
                    title={blameTitle(blame.short, blame.subject)}
                    aria-label="Filter by commit {blame.short}"
                  ></button>
                {/if}
              </span>
            {/if}
            <span
              class={gapGutterClass('old', oldLine, newLine)}
              style={gutterStyle(gutterWidth)}
              onmousedown={(e) => onGapGutterMousedown(e, newLine)}
              onmouseenter={(e) => {
                onGapGutterEnter(oldLine, newLine);
                scheduleHover('old', oldLine, newLine, e.currentTarget);
              }}
              onmouseleave={softCloseHover}
              role="presentation"
            >
              {oldLine}
              <CommentMarker
                starting={commentsStartingAt('new', newLine)}
                continuing={commentsContinuingAt('new', newLine)}
              />
            </span>
            <span
              class={gapGutterClass('new', oldLine, newLine)}
              style={gutterStyle(gutterWidth)}
              onmousedown={(e) => onGapGutterMousedown(e, newLine)}
              onmouseenter={(e) => {
                onGapGutterEnter(oldLine, newLine);
                scheduleHover('new', oldLine, newLine, e.currentTarget);
              }}
              onmouseleave={softCloseHover}
              role="presentation"
            >
              {newLine}
            </span>
            <span class="w-5 shrink-0 pl-1 text-center select-none">&nbsp;</span>
            <span class={textCls} data-diff-side="new" data-diff-line={newLine}
              >{@html renderText(text, 'context')}</span>
          </div>
        {:else}
          <div class="group/diffrow flex font-mono leading-[1.55]" style={bodyStyle}>
            {#if isRangeMode}
              <span
                class="relative flex shrink-0 items-center justify-center border-r border-border/60 bg-background select-none"
                style={blameGutterStyle()}
              >
                {#if blame}
                  <button
                    type="button"
                    class={[
                      'h-2 w-2 rounded-full transition-transform hover:scale-125',
                      activeChipFilter === blame.sha && 'ring-1 ring-offset-1 ring-foreground/60'
                    ]}
                    style:background-color={blame.color}
                    onclick={(e) => onBlameChipClick(e, blame.sha)}
                    title={blameTitle(blame.short, blame.subject)}
                    aria-label="Filter by commit {blame.short}"
                  ></button>
                {/if}
              </span>
            {/if}
            <div class="grid min-w-0 grow grid-cols-2 gap-px bg-border/50">
              <div class="flex min-h-[1.45em] bg-background">
                <span
                  class={gapGutterClass('old', oldLine, newLine)}
                  style={gutterStyle(gutterWidth)}
                  onmousedown={(e) => onGapGutterMousedown(e, newLine)}
                  onmouseenter={(e) => {
                    onGapGutterEnter(oldLine, newLine);
                    scheduleHover('old', oldLine, newLine, e.currentTarget);
                  }}
                  onmouseleave={softCloseHover}
                  role="presentation"
                >
                  {oldLine}
                  <CommentMarker
                    starting={commentsStartingAt('new', newLine)}
                    continuing={commentsContinuingAt('new', newLine)}
                  />
                </span>
                <span class={splitTextCls} data-diff-side="new" data-diff-line={newLine}
                  >{@html renderText(text, 'context')}</span>
              </div>
              <div class="flex min-h-[1.45em] bg-background">
                <span
                  class={gapGutterClass('new', oldLine, newLine)}
                  style={gutterStyle(gutterWidth)}
                  onmousedown={(e) => onGapGutterMousedown(e, newLine)}
                  onmouseenter={(e) => {
                    onGapGutterEnter(oldLine, newLine);
                    scheduleHover('new', oldLine, newLine, e.currentTarget);
                  }}
                  onmouseleave={softCloseHover}
                  role="presentation"
                >
                  {newLine}
                </span>
                <span class={splitTextCls} data-diff-side="new" data-diff-line={newLine}
                  >{@html renderText(text, 'context')}</span>
              </div>
            </div>
          </div>
        {/if}
      {:else if item.row.kind === 'gap-button'}
        {@const entry = gapButtonEntry(item.row.oldStart, item.row.oldEnd)}
        {@const gapSize = item.row.oldEnd - item.row.oldStart + 1}
        <button
          type="button"
          class="flex w-full items-center justify-center gap-1.5 border-y border-border bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
          onclick={() => void expandGap((item.row as GapButtonRow).oldStart, (item.row as GapButtonRow).oldEnd)}
          disabled={entry.loading}
          title={entry.error ?? `Show lines ${item.row.oldStart}–${item.row.oldEnd}`}
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
    </div>
  {/each}
  </div>
</div>

{#if hoverPreview}
  <div
    class="fixed z-50 w-80 max-w-sm rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    style:left="{Math.min(hoverPreview.rect.right + 8, (typeof window !== 'undefined' ? window.innerWidth : 1920) - 340)}px"
    style:top="{Math.max(8, hoverPreview.rect.top - 4)}px"
    role="tooltip"
    onmouseenter={keepHoverOpen}
    onmouseleave={cancelHover}
  >
    <div class="flex items-center justify-between border-b border-border px-2 py-1 text-[10px] text-muted-foreground">
      <span class="font-mono">
        {hoverPreview.side === 'old' ? 'before' : 'after'} L{hoverPreview.line}
      </span>
      {#if hoverPreview.comments.length > 1}
        <span>
          {hoverPreview.comments.length} comments
        </span>
      {/if}
    </div>
    <ul class="flex max-h-72 flex-col gap-2 overflow-auto overscroll-contain p-2">
      {#each hoverPreview.comments as c (c.id)}
        {@const agents = hoverAgentsFor(c)}
        <li class="flex flex-col gap-1 border-l-2 border-amber-500/60 pl-2">
          <div class="flex flex-wrap items-center justify-between gap-1.5 text-[10px] text-muted-foreground">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="font-mono">{hoverRangeLabel(c)}</span>
              {#if c.sentAt}
                <span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-medium tracking-wide text-emerald-700 uppercase dark:text-emerald-400">
                  <CheckCircle2 class="size-2.5" /> sent
                </span>
              {/if}
              {#if c.resolvedAt}
                <span class="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 font-medium tracking-wide text-muted-foreground uppercase">
                  <CircleCheck class="size-2.5" /> resolved
                </span>
              {/if}
            </div>
            <div class="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="xs"
                onclick={() => toggleResolveHoverComment(c)}
                aria-label={c.resolvedAt ? 'Reopen' : 'Resolve'}
                title={c.resolvedAt ? 'Reopen' : 'Resolve'}
              >
                {#if c.resolvedAt}
                  <CircleDot class="size-3" />
                {:else}
                  <CircleCheck class="size-3" />
                {/if}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onclick={() => editHoverComment(c.id)}
                aria-label="Edit"
                title="Edit"
              >
                <PencilLine class="size-3" />
              </Button>
            </div>
          </div>
          <div
            class="max-h-32 overflow-y-auto overscroll-contain font-mono text-[11px] leading-snug whitespace-pre-wrap break-words"
          >
            {c.text || '(empty)'}
          </div>
          {#if agents.length > 0}
            <div class="flex flex-wrap items-center gap-1">
              {#each agents as agent (agent.id)}
                <AgentBadge name={agent.name} provider={agent.provider} model={agent.model} />
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
