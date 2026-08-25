import { Buffer } from 'node:buffer';
import type { RuntimeHistorySnapshot, RuntimeOutputEvent } from '@soloe/protocol';
import { sanitizeTerminalHistoryChunk } from './TerminalHistorySanitizer.js';

export type TerminalOutputEvent = RuntimeOutputEvent;
export type TerminalHistorySnapshot = RuntimeHistorySnapshot;

export interface TerminalHistoryBufferOptions {
  maxBytesPerTerminal?: number;
  maxTotalBytes?: number;
  maxEventsPerTerminal?: number;
  maxTotalEvents?: number;
  unbounded?: boolean;
}

interface HistoryChunk {
  terminalId: string;
  seq: number;
  data: string;
  bytes: number;
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
  lastSeq: number;
  truncated: boolean;
  pendingControlSequence: string;
}

const DEFAULT_MAX_BYTES_PER_TERMINAL = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_EVENTS_PER_TERMINAL = 4096;
const DEFAULT_MAX_TOTAL_EVENTS = DEFAULT_MAX_EVENTS_PER_TERMINAL * 8;

/**
 * Renderer-neutral VT history owned beside the PTY. Ghostty reconstructs its
 * own parser and grid state from this stream in every browser presentation.
 */
export class TerminalHistoryBuffer {
  private readonly states = new Map<string, HistoryState>();
  private readonly globalOrder = new Set<HistoryChunk>();
  private totalBytes = 0;
  private readonly maxBytesPerTerminal: number;
  private readonly maxTotalBytes: number;
  private readonly maxEventsPerTerminal: number;
  private readonly maxTotalEvents: number;
  private unbounded: boolean;

  constructor(options: TerminalHistoryBufferOptions = {}) {
    this.maxBytesPerTerminal = positiveInteger(
      options.maxBytesPerTerminal,
      DEFAULT_MAX_BYTES_PER_TERMINAL
    );
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.maxEventsPerTerminal = positiveInteger(
      options.maxEventsPerTerminal,
      DEFAULT_MAX_EVENTS_PER_TERMINAL
    );
    this.maxTotalEvents = positiveInteger(options.maxTotalEvents, DEFAULT_MAX_TOTAL_EVENTS);
    this.unbounded = options.unbounded ?? false;
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

  setUnbounded(unbounded: boolean): void {
    if (this.unbounded === unbounded) return;
    this.unbounded = unbounded;
    if (unbounded) return;
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
    if (!this.unbounded && (bytes > this.maxBytesPerTerminal || bytes > this.maxTotalBytes)) {
      state.truncated = true;
      return;
    }

    const chunk: HistoryChunk = {
      terminalId: event.terminalId,
      seq: event.seq,
      data: sanitized.visibleText,
      bytes,
      cols: state.cols,
      rows: state.rows
    };
    state.chunks.add(chunk);
    state.bytes += bytes;
    this.totalBytes += bytes;
    this.globalOrder.add(chunk);

    if (this.unbounded) return;
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
  }

  retainedByteLength(): number {
    return this.totalBytes;
  }

  retainedEventCount(): number {
    return this.globalOrder.size;
  }

  private enforceTerminalLimits(state: HistoryState): void {
    while (state.bytes > this.maxBytesPerTerminal || state.chunks.size > this.maxEventsPerTerminal) {
      const oldest = firstOf(state.chunks);
      if (!oldest) break;
      this.evictChunk(state, oldest);
    }
  }

  private enforceGlobalLimits(): void {
    while (this.totalBytes > this.maxTotalBytes || this.globalOrder.size > this.maxTotalEvents) {
      const oldest = firstOf(this.globalOrder);
      if (!oldest) break;
      const owner = this.states.get(oldest.terminalId);
      if (owner) this.evictChunk(owner, oldest);
      else {
        this.globalOrder.delete(oldest);
        this.totalBytes = Math.max(0, this.totalBytes - oldest.bytes);
      }
    }
  }

  private evictChunk(state: HistoryState, chunk: HistoryChunk): void {
    if (!state.chunks.delete(chunk)) return;
    this.globalOrder.delete(chunk);
    state.bytes = Math.max(0, state.bytes - chunk.bytes);
    this.totalBytes = Math.max(0, this.totalBytes - chunk.bytes);
    state.truncated = true;
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}
