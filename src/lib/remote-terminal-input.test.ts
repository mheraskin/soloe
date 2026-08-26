import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteTerminalInputBatcher } from './remote-terminal-input';

describe('RemoteTerminalInputBatcher', () => {
  afterEach(() => vi.useRealTimers());

  it('micro-batches printable keyboard input', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const input = new RemoteTerminalInputBatcher((data) => sent.push(data), 20);

    input.submit('h', 'text');
    input.submit('e', 'text');
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(19);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(['he']);
  });

  it('flushes pending text before control, hotkey, mouse, and scroll input', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const input = new RemoteTerminalInputBatcher((data) => sent.push(data), 20);

    input.submit('hello', 'text');
    input.submit('\r', 'immediate');
    input.submit('\u001b[A', 'immediate');

    expect(sent).toEqual(['hello\r', '\u001b[A']);
    vi.runAllTimers();
    expect(sent).toEqual(['hello\r', '\u001b[A']);
  });

  it('sends terminal protocol replies immediately without delaying queued typing', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const input = new RemoteTerminalInputBatcher((data) => sent.push(data), 20);

    input.submit('typed', 'text');
    input.submit('\u001b[1;2R', 'protocol');
    expect(sent).toEqual(['\u001b[1;2R']);

    vi.advanceTimersByTime(20);
    expect(sent).toEqual(['\u001b[1;2R', 'typed']);
  });

  it('flushes pending text at a host-handled input boundary and on disposal', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const input = new RemoteTerminalInputBatcher((data) => sent.push(data), 20);

    input.submit('one', 'text');
    input.flush();
    input.submit('two', 'text');
    input.dispose();

    expect(sent).toEqual(['one', 'two']);
  });
});
