import { Buffer } from 'node:buffer';
import {
  DEFAULT_RUNTIME_HISTORY_LINE_LIMIT,
  MAX_RUNTIME_HISTORY_BYTES_PER_TERMINAL,
  type RuntimeHistorySnapshot,
  type RuntimeOutputEvent
} from '@soloe/protocol';
import { sanitizeTerminalHistoryChunk } from './TerminalHistorySanitizer.js';

export type TerminalOutputEvent = RuntimeOutputEvent;
export type TerminalHistorySnapshot = RuntimeHistorySnapshot;

export interface TerminalHistoryBufferOptions {
  maxLinesPerTerminal?: number;
  maxTotalLines?: number;
  maxBytesPerTerminal?: number;
  maxTotalBytes?: number;
  maxEventsPerTerminal?: number;
  maxTotalEvents?: number;
}

interface HistoryChunk {
  terminalId: string;
  seq: number;
  data: string;
  bytes: number;
  lineBreaks: number;
  cols: number;
  rows: number;
}

interface HistoryResize {
  afterSeq: number;
  cols: number;
  rows: number;
}

interface HistoryState {
  sessionId: string;
  cols: number;
  rows: number;
  chunks: Set<HistoryChunk>;
  resizes: HistoryResize[];
  bytes: number;
  lineBreaks: number;
  textChunks: number;
  tailEndsWithNewline: boolean;
  lastSeq: number;
  truncated: boolean;
  pendingControlSequence: string;
}

const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const GLOBAL_RETENTION_MULTIPLIER = 8;

/**
 * Renderer-neutral VT history owned beside the PTY. Ghostty reconstructs its
 * own parser and grid state from this stream in every browser presentation.
 */
export class TerminalHistoryBuffer {
  private readonly states = new Map<string, HistoryState>();
  private readonly globalOrder = new Set<HistoryChunk>();
  private totalBytes = 0;
  private totalLines = 0;
  private maxLinesPerTerminal: number;
  private maxTotalLines: number;
  private readonly maxBytesPerTerminal: number;
  private readonly maxTotalBytes: number;
  private maxEventsPerTerminal: number;
  private maxTotalEvents: number;
  private readonly totalLinesFollowTerminalLimit: boolean;
  private readonly terminalEventsFollowLineLimit: boolean;
  private readonly totalEventsFollowLineLimit: boolean;

  constructor(options: TerminalHistoryBufferOptions = {}) {
    this.maxLinesPerTerminal = positiveInteger(
      options.maxLinesPerTerminal,
      DEFAULT_RUNTIME_HISTORY_LINE_LIMIT
    );
    this.totalLinesFollowTerminalLimit = options.maxTotalLines === undefined;
    this.maxTotalLines = positiveInteger(
      options.maxTotalLines,
      this.maxLinesPerTerminal * GLOBAL_RETENTION_MULTIPLIER
    );
    this.maxBytesPerTerminal = positiveInteger(
      options.maxBytesPerTerminal,
      MAX_RUNTIME_HISTORY_BYTES_PER_TERMINAL
    );
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.terminalEventsFollowLineLimit = options.maxEventsPerTerminal === undefined;
    this.maxEventsPerTerminal = positiveInteger(
      options.maxEventsPerTerminal,
      this.maxLinesPerTerminal
    );
    this.totalEventsFollowLineLimit = options.maxTotalEvents === undefined;
    this.maxTotalEvents = positiveInteger(
      options.maxTotalEvents,
      this.maxLinesPerTerminal * GLOBAL_RETENTION_MULTIPLIER
    );
  }

  register(input: {
    terminalId: string;
    sessionId: string;
    cols: number;
    rows: number;
  }): void {
    const existing = this.states.get(input.terminalId);
    if (existing?.sessionId === input.sessionId) {
      this.resize(input.terminalId, input.cols, input.rows);
      return;
    }
    if (existing) this.remove(input.terminalId);
    this.states.set(input.terminalId, {
      sessionId: input.sessionId,
      cols: positiveInteger(input.cols, 1),
      rows: positiveInteger(input.rows, 1),
      chunks: new Set(),
      resizes: [],
      bytes: 0,
      lineBreaks: 0,
      textChunks: 0,
      tailEndsWithNewline: false,
      lastSeq: 0,
      truncated: false,
      pendingControlSequence: ''
    });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const state = this.states.get(terminalId);
    if (!state) return;
    const nextCols = positiveInteger(cols, state.cols);
    const nextRows = positiveInteger(rows, state.rows);
    if (nextCols === state.cols && nextRows === state.rows) return;
    state.cols = nextCols;
    state.rows = nextRows;
    if (state.chunks.size > 0) {
      state.resizes.push({ afterSeq: state.lastSeq, cols: nextCols, rows: nextRows });
    }
  }

  setLineLimit(lineLimit: number): void {
    const next = positiveInteger(lineLimit, this.maxLinesPerTerminal);
    if (next === this.maxLinesPerTerminal) return;
    this.maxLinesPerTerminal = next;
    if (this.totalLinesFollowTerminalLimit) {
      this.maxTotalLines = next * GLOBAL_RETENTION_MULTIPLIER;
    }
    if (this.terminalEventsFollowLineLimit) this.maxEventsPerTerminal = next;
    if (this.totalEventsFollowLineLimit) {
      this.maxTotalEvents = next * GLOBAL_RETENTION_MULTIPLIER;
    }
    for (const state of this.states.values()) this.enforceTerminalLimits(state);
    this.enforceGlobalLimits();
  }

  append(event: TerminalOutputEvent): void {
    if (!this.states.has(event.terminalId)) {
      this.register({
        terminalId: event.terminalId,
        sessionId: event.sessionId,
        cols: 1,
        rows: 1
      });
    }
    const state = this.states.get(event.terminalId)!;
    if (state.sessionId !== event.sessionId || event.seq <= state.lastSeq) return;
    if (state.lastSeq > 0 && event.seq !== state.lastSeq + 1) state.truncated = true;
    state.lastSeq = event.seq;

    const sanitized = sanitizeTerminalHistoryChunk(state.pendingControlSequence, event.data);
    state.pendingControlSequence = sanitized.pendingControlSequence;
    const bytes = Buffer.byteLength(sanitized.visibleText, 'utf8');
    if (bytes > this.maxBytesPerTerminal || bytes > this.maxTotalBytes) {
      state.truncated = true;
      return;
    }

    const previousLines = stateLineCount(state);
    const chunk: HistoryChunk = {
      terminalId: event.terminalId,
      seq: event.seq,
      data: sanitized.visibleText,
      bytes,
      lineBreaks: countLineBreaks(sanitized.visibleText),
      cols: state.cols,
      rows: state.rows
    };
    state.chunks.add(chunk);
    state.bytes += bytes;
    state.lineBreaks += chunk.lineBreaks;
    if (chunk.data.length > 0) {
      state.textChunks += 1;
      state.tailEndsWithNewline = chunk.data.endsWith('\n');
    }
    this.totalBytes += bytes;
    this.totalLines += stateLineCount(state) - previousLines;
    this.globalOrder.add(chunk);

    this.enforceTerminalLimits(state);
    this.enforceGlobalLimits();
  }

  snapshot(terminalId: string): TerminalHistorySnapshot | null {
    const state = this.states.get(terminalId);
    if (!state) return null;
    const chunks = [...state.chunks];
    const replay = replayPlan(chunks, state.resizes, state.cols, state.rows);
    return {
      kind: 'ghostty-vt-history-v1',
      terminalId,
      sessionId: state.sessionId,
      cols: state.cols,
      rows: state.rows,
      data: chunks.map((chunk) => chunk.data).join(''),
      fromSeq: chunks[0]?.seq ?? state.lastSeq + 1,
      toSeq: state.lastSeq,
      truncated: state.truncated,
      byteLength: state.bytes,
      replay
    };
  }

  remove(terminalId: string): void {
    const state = this.states.get(terminalId);
    if (!state) return;
    this.totalLines = Math.max(0, this.totalLines - stateLineCount(state));
    for (const chunk of state.chunks) {
      this.globalOrder.delete(chunk);
      this.totalBytes = Math.max(0, this.totalBytes - chunk.bytes);
    }
    state.chunks.clear();
    state.resizes = [];
    this.states.delete(terminalId);
  }

  clear(): void {
    this.states.clear();
    this.globalOrder.clear();
    this.totalBytes = 0;
    this.totalLines = 0;
  }

  retainedByteLength(): number {
    return this.totalBytes;
  }

  retainedEventCount(): number {
    return this.globalOrder.size;
  }

  retainedLineCount(): number {
    return this.totalLines;
  }

  private enforceTerminalLimits(state: HistoryState): void {
    while (
      stateLineCount(state) > this.maxLinesPerTerminal
      || state.bytes > this.maxBytesPerTerminal
      || state.chunks.size > this.maxEventsPerTerminal
    ) {
      const oldest = firstOf(state.chunks);
      if (!oldest) break;
      const excessLines = stateLineCount(state) - this.maxLinesPerTerminal;
      if (excessLines > 0 && oldest.lineBreaks >= excessLines) {
        this.trimLeadingLines(state, oldest, excessLines);
        continue;
      }
      this.evictChunk(state, oldest);
    }
  }

  private enforceGlobalLimits(): void {
    while (
      this.totalLines > this.maxTotalLines
      || this.totalBytes > this.maxTotalBytes
      || this.globalOrder.size > this.maxTotalEvents
    ) {
      const oldest = firstOf(this.globalOrder);
      if (!oldest) break;
      const owner = this.states.get(oldest.terminalId);
      const excessLines = this.totalLines - this.maxTotalLines;
      if (owner && excessLines > 0 && oldest.lineBreaks >= excessLines) {
        this.trimLeadingLines(owner, oldest, excessLines);
      } else if (owner) this.evictChunk(owner, oldest);
      else {
        this.globalOrder.delete(oldest);
        this.totalBytes = Math.max(0, this.totalBytes - oldest.bytes);
      }
    }
  }

  private evictChunk(state: HistoryState, chunk: HistoryChunk): void {
    const previousLines = stateLineCount(state);
    if (!state.chunks.delete(chunk)) return;
    this.globalOrder.delete(chunk);
    state.bytes = Math.max(0, state.bytes - chunk.bytes);
    state.lineBreaks = Math.max(0, state.lineBreaks - chunk.lineBreaks);
    if (chunk.data.length > 0) state.textChunks = Math.max(0, state.textChunks - 1);
    if (state.textChunks === 0) state.tailEndsWithNewline = false;
    this.totalBytes = Math.max(0, this.totalBytes - chunk.bytes);
    this.totalLines = Math.max(0, this.totalLines - (previousLines - stateLineCount(state)));
    state.truncated = true;
    this.pruneResizes(state);
  }

  private trimLeadingLines(state: HistoryState, chunk: HistoryChunk, lines: number): void {
    const previousLines = stateLineCount(state);
    const cut = indexAfterLineBreaks(chunk.data, lines);
    const removed = chunk.data.slice(0, cut);
    const removedBytes = Buffer.byteLength(removed, 'utf8');
    chunk.data = chunk.data.slice(cut);
    chunk.bytes = Math.max(0, chunk.bytes - removedBytes);
    chunk.lineBreaks = Math.max(0, chunk.lineBreaks - lines);
    state.bytes = Math.max(0, state.bytes - removedBytes);
    state.lineBreaks = Math.max(0, state.lineBreaks - lines);
    this.totalBytes = Math.max(0, this.totalBytes - removedBytes);
    if (chunk.data.length === 0) {
      state.chunks.delete(chunk);
      this.globalOrder.delete(chunk);
      state.textChunks = Math.max(0, state.textChunks - 1);
      if (state.textChunks === 0) state.tailEndsWithNewline = false;
    }
    this.totalLines = Math.max(0, this.totalLines - (previousLines - stateLineCount(state)));
    state.truncated = true;
    this.pruneResizes(state);
  }

  private pruneResizes(state: HistoryState): void {
    const firstRetained = firstOf(state.chunks);
    state.resizes = firstRetained
      ? state.resizes.filter((resize) => resize.afterSeq >= firstRetained.seq)
      : [];
  }
}

function replayPlan(
  chunks: HistoryChunk[],
  resizes: HistoryResize[],
  finalCols: number,
  finalRows: number
): { cols: number; rows: number; resizes: Array<{ offset: number; cols: number; rows: number }> } {
  const first = chunks[0];
  const plan = {
    cols: first?.cols ?? finalCols,
    rows: first?.rows ?? finalRows,
    resizes: [] as Array<{ offset: number; cols: number; rows: number }>
  };
  let cols = plan.cols;
  let rows = plan.rows;
  let offset = 0;
  let resizeIndex = 0;
  for (const chunk of chunks) {
    if (chunk.cols !== cols || chunk.rows !== rows) {
      plan.resizes.push({ offset, cols: chunk.cols, rows: chunk.rows });
      cols = chunk.cols;
      rows = chunk.rows;
    }
    offset += chunk.data.length;
    while (resizeIndex < resizes.length && resizes[resizeIndex]!.afterSeq <= chunk.seq) {
      const resize = resizes[resizeIndex++]!;
      if (resize.cols === cols && resize.rows === rows) continue;
      plan.resizes.push({ offset, cols: resize.cols, rows: resize.rows });
      cols = resize.cols;
      rows = resize.rows;
    }
  }
  while (resizeIndex < resizes.length) {
    const resize = resizes[resizeIndex++]!;
    if (resize.cols === cols && resize.rows === rows) continue;
    plan.resizes.push({ offset, cols: resize.cols, rows: resize.rows });
    cols = resize.cols;
    rows = resize.rows;
  }
  if (cols !== finalCols || rows !== finalRows) {
    plan.resizes.push({ offset, cols: finalCols, rows: finalRows });
  }
  return plan;
}

function firstOf<T>(values: Set<T>): T | null {
  const next = values.values().next();
  return next.done ? null : next.value;
}

function stateLineCount(state: HistoryState): number {
  return state.lineBreaks + (state.textChunks > 0 && !state.tailEndsWithNewline ? 1 : 0);
}

function countLineBreaks(data: string): number {
  let count = 0;
  for (let index = data.indexOf('\n'); index >= 0; index = data.indexOf('\n', index + 1)) {
    count += 1;
  }
  return count;
}

function indexAfterLineBreaks(data: string, count: number): number {
  let index = -1;
  for (let found = 0; found < count; found += 1) {
    index = data.indexOf('\n', index + 1);
  }
  return index + 1;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}
