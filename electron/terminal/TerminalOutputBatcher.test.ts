import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalOutputEvent } from '@shared/types/terminal.js';
import { TerminalOutputBatcher } from './TerminalOutputBatcher.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalOutputBatcher', () => {
  it('coalesces raw chunks per terminal and advances independent sequences', () => {
    vi.useFakeTimers();
    const flush = vi.fn<(events: TerminalOutputEvent[]) => void>();
    const batcher = new TerminalOutputBatcher(16, flush);

    batcher.push('t-1', 's-1', 'a');
    batcher.push('t-2', 's-2', 'x');
    batcher.push('t-1', 's-1', 'b');
    vi.advanceTimersByTime(16);

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]?.[0]).toEqual([
      { terminalId: 't-1', sessionId: 's-1', data: 'ab', seq: 1 },
      { terminalId: 't-2', sessionId: 's-2', data: 'x', seq: 1 }
    ]);
    batcher.destroy();
  });

  it('flushes one terminal immediately and drains final bytes on destroy', () => {
    vi.useFakeTimers();
    const published: TerminalOutputEvent[] = [];
    const batcher = new TerminalOutputBatcher(16, (events) => published.push(...events));

    batcher.push('t-1', 's-1', 'first');
    batcher.flushTerminal('t-1');
    batcher.push('t-1', 's-1', 'final');
    batcher.destroy();
    batcher.push('t-1', 's-1', 'ignored');
    vi.runAllTimers();

    expect(published).toEqual([
      { terminalId: 't-1', sessionId: 's-1', data: 'first', seq: 1 },
      { terminalId: 't-1', sessionId: 's-1', data: 'final', seq: 2 }
    ]);
  });
});
