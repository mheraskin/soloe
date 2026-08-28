import type { SessionHookTraceEvent } from '@shared/types/session-debug.js';

const DEFAULT_CAPACITY = 5_000;
const DEFAULT_BYTE_CAPACITY = 32 * 1024 * 1024;

interface StoredTraceEvent {
  event: SessionHookTraceEvent;
  bytes: number;
}

export class SessionHookTraceBuffer {
  private entries: StoredTraceEvent[] = [];
  private listeners = new Set<(event: SessionHookTraceEvent) => void>();
  private enabled = false;
  private retainedBytes = 0;

  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly byteCapacity = DEFAULT_BYTE_CAPACITY
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  append(event: SessionHookTraceEvent): void {
    if (!this.enabled) return;
    const stored = { event, bytes: eventBytes(event) } satisfies StoredTraceEvent;
    this.entries.push(stored);
    this.retainedBytes += stored.bytes;
    while (
      this.entries.length > 1
      && (this.entries.length > this.capacity || this.retainedBytes > this.byteCapacity)
    ) {
      const removed = this.entries.shift();
      if (removed) this.retainedBytes -= removed.bytes;
    }
    for (const listener of this.listeners) listener(event);
  }

  list(limit = this.capacity): SessionHookTraceEvent[] {
    const boundedLimit = Math.max(0, Math.min(Math.floor(limit), this.capacity));
    if (boundedLimit === 0) return [];
    return this.entries.slice(-boundedLimit).map((entry) => entry.event);
  }

  clear(): void {
    this.entries = [];
    this.retainedBytes = 0;
  }

  onEvent(listener: (event: SessionHookTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function eventBytes(event: SessionHookTraceEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}
