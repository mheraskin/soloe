import { describe, expect, it, vi } from 'vitest';

import { TerminalScreenState } from './TerminalScreenState.js';

describe('TerminalScreenState', () => {
  it('serializes sequence-qualified scrollback without renderer work', async () => {
    const serialize = vi.fn(() => '\u001b[2Jcurrent screen');
    const terminal = fakeTerminal();
    const screens = new TerminalScreenState({
      createTerminal: () => ({ terminal, serialize })
    });

    screens.register({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      cols: 120,
      rows: 30
    });
    await screens.write('terminal-1', 1, 'old output');
    await screens.write('terminal-1', 2, 'current output');

    await expect(screens.snapshot('terminal-1')).resolves.toEqual({
      kind: 'xterm-vt-state-v1',
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      cols: 120,
      rows: 30,
      toSeq: 2,
      data: '\u001b[2Jcurrent screen'
    });
    expect(serialize).toHaveBeenCalledWith({ scrollback: 10_000 });
    expect(terminal.open).toBeUndefined();
  });

  it('waits for queued output and preserves canonical resize ordering', async () => {
    const terminal = fakeTerminal();
    const screens = new TerminalScreenState({
      createTerminal: () => ({ terminal, serialize: () => terminal.output.join('') })
    });
    screens.register({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      cols: 80,
      rows: 24
    });

    const writing = screens.write('terminal-1', 3, 'frame');
    const resizing = screens.resize('terminal-1', 100, 32);
    const snapshot = screens.snapshot('terminal-1');

    await expect(Promise.all([writing, resizing, snapshot])).resolves.toEqual([
      undefined,
      undefined,
      expect.objectContaining({ cols: 100, rows: 32, toSeq: 3, data: 'frame' })
    ]);
    expect(terminal.operations).toEqual(['write:frame', 'resize:100x32']);
  });
});

function fakeTerminal() {
  const output: string[] = [];
  const operations: string[] = [];
  return {
    output,
    operations,
    open: undefined,
    write(data: string, callback: () => void) {
      operations.push(`write:${data}`);
      output.push(data);
      queueMicrotask(callback);
    },
    resize(cols: number, rows: number) {
      operations.push(`resize:${cols}x${rows}`);
    },
    dispose: vi.fn()
  };
}
