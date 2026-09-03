import { describe, expect, it } from 'vitest';
import { TerminalHistoryBuffer } from './TerminalHistoryBuffer.js';

describe('TerminalHistoryBuffer', () => {
  it('returns one ordered renderer-neutral history snapshot', () => {
    const replay = new TerminalHistoryBuffer();
    replay.register({ terminalId: 't-1', sessionId: 'session-t-1', cols: 120, rows: 30 });
    replay.append(event('t-1', 1, 'one'));
    replay.append(event('t-1', 2, 'two'));
    replay.append(event('t-1', 3, 'three'));

    expect(replay.snapshot('t-1')).toEqual({
      kind: 'ghostty-vt-history-v1',
      terminalId: 't-1',
      sessionId: 'session-t-1',
      cols: 120,
      rows: 30,
      data: 'onetwothree',
      replay: {
        cols: 120,
        rows: 30,
        resizes: []
      },
      fromSeq: 1,
      toSeq: 3,
      truncated: false,
      byteLength: 11
    });
  });

  it('retains resize chronology beside VT bytes for exact cold replay', () => {
    const replay = new TerminalHistoryBuffer();
    replay.register({ terminalId: 't-1', sessionId: 'session-t-1', cols: 10, rows: 4 });
    replay.append(event('t-1', 1, 'first'));
    replay.resize('t-1', 20, 6);
    replay.append(event('t-1', 2, 'second'));
    replay.resize('t-1', 30, 8);

    expect(replay.snapshot('t-1')).toMatchObject({
      cols: 30,
      rows: 8,
      data: 'firstsecond',
      replay: {
        cols: 10,
        rows: 4,
        resizes: [
          { offset: 5, cols: 20, rows: 6 },
          { offset: 11, cols: 30, rows: 8 }
        ]
      }
    });
  });

  it('retains intermediate resizes even when no output was emitted between them', () => {
    const replay = new TerminalHistoryBuffer();
    replay.register({ terminalId: 't-1', sessionId: 'session-t-1', cols: 10, rows: 4 });
    replay.append(event('t-1', 1, 'first'));
    replay.resize('t-1', 5, 2);
    replay.resize('t-1', 20, 6);
    replay.append(event('t-1', 2, 'second'));

    expect(replay.snapshot('t-1')?.replay).toEqual({
      cols: 10,
      rows: 4,
      resizes: [
        { offset: 5, cols: 5, rows: 2 },
        { offset: 5, cols: 20, rows: 6 }
      ]
    });
  });

  it('evicts whole events at the per-terminal byte and event ceilings', () => {
    const replay = new TerminalHistoryBuffer({
      maxBytesPerTerminal: 6,
      maxTotalBytes: 100,
      maxEventsPerTerminal: 2
    });
    replay.append(event('t-1', 1, 'aaa'));
    replay.append(event('t-1', 2, 'bb'));
    replay.append(event('t-1', 3, 'ccc'));

    expect(replay.snapshot('t-1')).toMatchObject({
      data: 'bbccc',
      fromSeq: 2,
      toSeq: 3,
      truncated: true,
      byteLength: 5
    });
    expect(replay.retainedByteLength()).toBe(5);
  });

  it('enforces one global byte ceiling across terminals in arrival order', () => {
    const replay = new TerminalHistoryBuffer({
      maxBytesPerTerminal: 20,
      maxTotalBytes: 7
    });
    replay.append(event('t-1', 1, 'aaaa'));
    replay.append(event('t-2', 1, 'bbbb'));

    expect(replay.snapshot('t-1')).toMatchObject({ data: '', truncated: true });
    expect(replay.snapshot('t-2')).toMatchObject({ data: 'bbbb', truncated: false });
    expect(replay.retainedByteLength()).toBe(4);
  });

  it('never retains an individual event larger than either byte ceiling', () => {
    const replay = new TerminalHistoryBuffer({
      maxBytesPerTerminal: 4,
      maxTotalBytes: 8
    });
    replay.append(event('t-1', 1, 'oversized'));

    expect(replay.snapshot('t-1')).toMatchObject({
      data: '',
      fromSeq: 2,
      toSeq: 1,
      truncated: true,
      byteLength: 0
    });
    expect(replay.retainedByteLength()).toBe(0);
  });

  it('marks retained history as truncated when the output sequence has a gap', () => {
    const replay = new TerminalHistoryBuffer();
    replay.append(event('t-1', 1, 'one'));
    replay.append(event('t-1', 3, 'three'));

    expect(replay.snapshot('t-1')).toMatchObject({
      data: 'onethree',
      fromSeq: 1,
      toSeq: 3,
      truncated: true
    });
  });

  it('forgets terminal state and releases its global budget', () => {
    const replay = new TerminalHistoryBuffer();
    replay.append(event('t-1', 1, 'abc'));
    replay.remove('t-1');

    expect(replay.snapshot('t-1')).toBeNull();
    expect(replay.retainedByteLength()).toBe(0);
  });

  it('keeps retained output globally constant across one hundred noisy terminals', () => {
    const replay = new TerminalHistoryBuffer({
      maxBytesPerTerminal: 4096,
      maxTotalBytes: 8192
    });
    for (let index = 0; index < 100; index += 1) {
      replay.append(event(`t-${index}`, 1, 'x'.repeat(1024)));
    }

    expect(replay.retainedByteLength()).toBe(8192);
    expect(replay.snapshot('t-0')).toMatchObject({ data: '', truncated: true });
    expect(replay.snapshot('t-99')).toMatchObject({ data: 'x'.repeat(1024), truncated: false });
  });

  it('does not retain evicted chronology behind an earlier quiet terminal', () => {
    const replay = new TerminalHistoryBuffer({
      maxBytesPerTerminal: 4096,
      maxTotalBytes: 8192,
      maxEventsPerTerminal: 4096,
      maxTotalEvents: 8192
    });
    replay.append(event('quiet', 1, 'q'));
    for (let seq = 1; seq <= 100_000; seq += 1) {
      replay.append(event('noisy', seq, 'x'));
    }

    expect(replay.retainedEventCount()).toBe(4097);
    expect(replay.retainedByteLength()).toBe(4097);
    expect(replay.snapshot('quiet')).toMatchObject({ data: 'q', fromSeq: 1, toSeq: 1 });
    expect(replay.snapshot('noisy')).toMatchObject({
      data: 'x'.repeat(4096),
      fromSeq: 95_905,
      toSeq: 100_000,
      truncated: true
    });
  });

  it('removing a noisy terminal leaves no chronology pinned by quiet terminals', () => {
    const replay = new TerminalHistoryBuffer({
      maxBytesPerTerminal: 128,
      maxTotalBytes: 1024,
      maxEventsPerTerminal: 128
    });
    replay.append(event('quiet-a', 1, 'a'));
    replay.append(event('quiet-b', 1, 'b'));
    for (let seq = 1; seq <= 10_000; seq += 1) {
      replay.append(event('noisy', seq, 'x'));
    }
    expect(replay.retainedEventCount()).toBe(130);

    replay.remove('noisy');

    expect(replay.retainedEventCount()).toBe(2);
    expect(replay.retainedByteLength()).toBe(2);
    expect(replay.snapshot('noisy')).toBeNull();
  });

  it('bounds global event objects even when payload bytes are tiny', () => {
    const replay = new TerminalHistoryBuffer({
      maxBytesPerTerminal: 100,
      maxTotalBytes: 100,
      maxEventsPerTerminal: 100,
      maxTotalEvents: 5
    });
    for (let terminal = 0; terminal < 10; terminal += 1) {
      replay.append(event(`t-${terminal}`, 1, ''));
    }

    expect(replay.retainedEventCount()).toBe(5);
    expect(replay.snapshot('t-4')).toMatchObject({ data: '', truncated: true });
    expect(replay.snapshot('t-5')).toMatchObject({ data: '', truncated: false });
    expect(replay.snapshot('t-9')).toMatchObject({ data: '', truncated: false });
  });

  it('retains the newest logical lines and trims inside one output event', () => {
    const replay = new TerminalHistoryBuffer({
      maxLinesPerTerminal: 2,
      maxTotalLines: 20
    });
    replay.append(event('t-1', 1, 'one\ntwo\nthree\n'));

    expect(replay.snapshot('t-1')).toMatchObject({
      data: 'two\nthree\n',
      fromSeq: 1,
      toSeq: 1,
      truncated: true
    });
    expect(replay.retainedLineCount()).toBe(2);
  });

  it('applies a lower replay line limit to history already retained', () => {
    const replay = new TerminalHistoryBuffer({
      maxLinesPerTerminal: 3,
      maxTotalLines: 30
    });
    replay.append(event('t-1', 1, 'one\n'));
    replay.append(event('t-1', 2, 'two\n'));
    replay.append(event('t-1', 3, 'three\n'));

    replay.setLineLimit(2);

    expect(replay.snapshot('t-1')).toMatchObject({
      data: 'two\nthree\n',
      fromSeq: 2,
      toSeq: 3,
      truncated: true
    });
    expect(replay.retainedLineCount()).toBe(2);
  });

  it('counts one logical line across adjacent output events', () => {
    const replay = new TerminalHistoryBuffer({
      maxLinesPerTerminal: 1,
      maxTotalLines: 10
    });
    replay.append(event('t-1', 1, 'one'));
    replay.append(event('t-1', 2, '\ntwo'));

    expect(replay.snapshot('t-1')).toMatchObject({
      data: 'two',
      fromSeq: 2,
      toSeq: 2,
      truncated: true
    });
    expect(replay.retainedLineCount()).toBe(1);
  });

  it('enforces the global line limit across terminals in arrival order', () => {
    const replay = new TerminalHistoryBuffer({
      maxLinesPerTerminal: 10,
      maxTotalLines: 3
    });
    replay.append(event('t-1', 1, 'one\ntwo\n'));
    replay.append(event('t-2', 1, 'three\nfour\n'));

    expect(replay.snapshot('t-1')).toMatchObject({ data: 'two\n', truncated: true });
    expect(replay.snapshot('t-2')).toMatchObject({ data: 'three\nfour\n', truncated: false });
    expect(replay.retainedLineCount()).toBe(3);
  });

  it('removes terminal queries without changing visual VT output', () => {
    const history = new TerminalHistoryBuffer();
    history.append(event('t-1', 1, 'before\u001b[6n\u001b[31mred\u001b[0m'));
    history.append(event('t-1', 2, '\u001b]10;?\u0007after'));

    expect(history.snapshot('t-1')).toMatchObject({
      data: 'before\u001b[31mred\u001b[0mafter',
      fromSeq: 1,
      toSeq: 2
    });
  });

  it('sanitizes query sequences split across output events', () => {
    const history = new TerminalHistoryBuffer();
    history.append(event('t-1', 1, 'before\u001b]11;'));
    history.append(event('t-1', 2, '?\u001b\\after'));

    expect(history.snapshot('t-1')).toMatchObject({
      data: 'beforeafter',
      fromSeq: 1,
      toSeq: 2
    });
  });
});

function event(terminalId: string, seq: number, data: string) {
  return { terminalId, sessionId: `session-${terminalId}`, seq, data };
}
