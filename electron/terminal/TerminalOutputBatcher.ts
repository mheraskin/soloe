import type { SessionId } from '@shared/types/sessions.js';
import type { TerminalId, TerminalOutputEvent } from '@shared/types/terminal.js';

interface Buffer {
  sessionId: SessionId;
  chunks: string[];
}

export type BatchFlushFn = (events: TerminalOutputEvent[]) => void;

export class TerminalOutputBatcher {
  private readonly buffers = new Map<TerminalId, Buffer>();
  private readonly seqs = new Map<TerminalId, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private readonly intervalMs: number,
    private readonly flushFn: BatchFlushFn
  ) {}

  push(terminalId: TerminalId, sessionId: SessionId, data: string): void {
    if (this.destroyed) return;
    let buffer = this.buffers.get(terminalId);
    if (!buffer) {
      buffer = { sessionId, chunks: [] };
      this.buffers.set(terminalId, buffer);
    }
    buffer.chunks.push(data);
    this.scheduleFlush();
  }

  flushTerminal(terminalId: TerminalId): void {
    const buffer = this.buffers.get(terminalId);
    if (!buffer || buffer.chunks.length === 0) return;
    const event = this.drainBuffer(terminalId, buffer);
    if (event) this.flushFn([event]);
  }

  flushAll(): void {
    if (this.buffers.size === 0) return;
    const events: TerminalOutputEvent[] = [];
    for (const [terminalId, buffer] of this.buffers) {
      if (buffer.chunks.length === 0) continue;
      const event = this.drainBuffer(terminalId, buffer);
      if (event) events.push(event);
    }
    if (events.length > 0) this.flushFn(events);
  }

  removeTerminal(terminalId: TerminalId): void {
    this.flushTerminal(terminalId);
    this.buffers.delete(terminalId);
    this.seqs.delete(terminalId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushAll();
    this.buffers.clear();
    this.seqs.clear();
  }

  private drainBuffer(terminalId: TerminalId, buffer: Buffer): TerminalOutputEvent | null {
    if (buffer.chunks.length === 0) return null;
    const data = buffer.chunks.join('');
    buffer.chunks.length = 0;
    const seq = (this.seqs.get(terminalId) ?? 0) + 1;
    this.seqs.set(terminalId, seq);
    return { terminalId, sessionId: buffer.sessionId, data, seq };
  }

  private scheduleFlush(): void {
    if (this.timer || this.destroyed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushAll();
    }, this.intervalMs);
  }
}
