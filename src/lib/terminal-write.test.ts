import { describe, expect, it, vi } from 'vitest';

import { writeTerminalData } from './terminal-write.js';

describe('writeTerminalData', () => {
  it('keeps restoration hidden until xterm has applied the complete replay', async () => {
    let applied!: () => void;
    const order: string[] = [];
    const terminal = {
      write: vi.fn((_data: string, callback: () => void) => {
        applied = callback;
        order.push('queued');
      }),
      reset: vi.fn(() => order.push('reset')),
      scrollToBottom: vi.fn(() => order.push('bottom'))
    };
    const settled = vi.fn(() => order.push('settled'));

    const writing = writeTerminalData(terminal, 'complete replay', {
      replace: true,
      onSettled: settled
    });
    expect(order).toEqual(['reset', 'queued']);
    expect(settled).not.toHaveBeenCalled();

    applied();
    await writing;

    expect(order).toEqual(['reset', 'queued', 'bottom', 'settled']);
  });

  it('does not force live output to the bottom when the user is reading history', async () => {
    const terminal = {
      write: (_data: string, callback: () => void) => callback(),
      reset: vi.fn(),
      scrollToBottom: vi.fn()
    };

    await writeTerminalData(terminal, 'live output');

    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });
});
