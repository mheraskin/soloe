import { Buffer } from "node:buffer";
import type {
  RuntimeOutputEvent,
  RuntimeReplaySnapshot,
} from "@soloe/protocol";

export type TerminalOutputEvent = RuntimeOutputEvent;
export type TerminalReplaySnapshot = RuntimeReplaySnapshot;

export interface TerminalReplayBufferOptions {
  maxBytesPerTerminal?: number;
  maxTotalBytes?: number;
  maxEventsPerTerminal?: number;
  maxTotalEvents?: number;
}

interface ReplayChunk {
  terminalId: string;
  seq: number;
  data: string;
  bytes: number;
}

interface ReplayState {
  sessionId: string;
  chunks: Set<ReplayChunk>;
  bytes: number;
  lastSeq: number;
  truncated: boolean;
}

const DEFAULT_MAX_BYTES_PER_TERMINAL = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_EVENTS_PER_TERMINAL = 4096;
const DEFAULT_MAX_TOTAL_EVENTS = DEFAULT_MAX_EVENTS_PER_TERMINAL * 8;

export class TerminalReplayBuffer {
  private readonly states = new Map<string, ReplayState>();
  private readonly globalOrder = new Set<ReplayChunk>();
  private totalBytes = 0;
  private readonly maxBytesPerTerminal: number;
  private readonly maxTotalBytes: number;
  private readonly maxEventsPerTerminal: number;
  private readonly maxTotalEvents: number;

  constructor(options: TerminalReplayBufferOptions = {}) {
    this.maxBytesPerTerminal = positiveInteger(
      options.maxBytesPerTerminal,
      DEFAULT_MAX_BYTES_PER_TERMINAL,
    );
    this.maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.maxEventsPerTerminal = positiveInteger(
      options.maxEventsPerTerminal,
      DEFAULT_MAX_EVENTS_PER_TERMINAL,
    );
    this.maxTotalEvents = positiveInteger(options.maxTotalEvents, DEFAULT_MAX_TOTAL_EVENTS);
  }

  append(event: TerminalOutputEvent): void {
    let state = this.states.get(event.terminalId);
    if (!state) {
      state = {
        sessionId: event.sessionId,
        chunks: new Set(),
        bytes: 0,
        lastSeq: 0,
        truncated: false,
      };
      this.states.set(event.terminalId, state);
    }
    if (event.seq <= state.lastSeq) return;
    if (state.lastSeq > 0 && event.seq !== state.lastSeq + 1) state.truncated = true;
    state.lastSeq = event.seq;

    const bytes = Buffer.byteLength(event.data, "utf8");
    if (bytes > this.maxBytesPerTerminal || bytes > this.maxTotalBytes) {
      state.truncated = true;
      return;
    }

    const chunk = { terminalId: event.terminalId, seq: event.seq, data: event.data, bytes };
    state.chunks.add(chunk);
    state.bytes += bytes;
    this.totalBytes += bytes;
    this.globalOrder.add(chunk);

    while (
      state.bytes > this.maxBytesPerTerminal ||
      state.chunks.size > this.maxEventsPerTerminal
    ) {
      const oldest = firstOf(state.chunks);
      if (!oldest) break;
      this.evictChunk(state, oldest);
    }
    while (
      this.totalBytes > this.maxTotalBytes ||
      this.globalOrder.size > this.maxTotalEvents
    ) {
      const oldest = firstOf(this.globalOrder);
      if (!oldest) break;
      const owner = this.states.get(oldest.terminalId);
      if (owner) {
        this.evictChunk(owner, oldest);
      } else {
        this.globalOrder.delete(oldest);
        this.totalBytes = Math.max(0, this.totalBytes - oldest.bytes);
      }
    }
  }

  snapshot(terminalId: string, afterSeq = 0): TerminalReplaySnapshot | null {
    const state = this.states.get(terminalId);
    if (!state) return null;
    const requestedAfter = Math.max(0, Math.trunc(afterSeq));
    const chunks = Array.from(state.chunks).filter((chunk) => chunk.seq > requestedAfter);
    const firstAvailableSeq = chunks[0]?.seq ?? state.lastSeq + 1;
    const truncated =
      requestedAfter === 0
        ? state.truncated
        : requestedAfter < state.lastSeq && firstAvailableSeq > requestedAfter + 1;
    return {
      terminalId,
      sessionId: state.sessionId,
      data: chunks.map((chunk) => chunk.data).join(""),
      fromSeq: chunks[0]?.seq ?? state.lastSeq + 1,
      toSeq: state.lastSeq,
      truncated,
      byteLength: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
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

  private evictChunk(state: ReplayState, chunk: ReplayChunk): void {
    if (!state.chunks.delete(chunk)) return;
    this.globalOrder.delete(chunk);
    state.bytes = Math.max(0, state.bytes - chunk.bytes);
    this.totalBytes = Math.max(0, this.totalBytes - chunk.bytes);
    state.truncated = true;
  }
}

function firstOf<T>(values: Set<T>): T | null {
  const next = values.values().next();
  return next.done ? null : next.value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}
