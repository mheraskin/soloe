import { describe, expect, it, vi } from 'vitest';
import type { TerminalHistorySnapshot, TerminalOutputEvent } from '@shared/types/terminal.js';
import {
  TerminalHistorySession,
  type TerminalSessionSource,
  type TerminalSessionState
} from './terminal-session';

describe('TerminalHistorySession', () => {
  it('subscribes and enables demand before reconciling snapshot with live output', async () => {
    const history = deferred<TerminalHistorySnapshot | null>();
    const fixture = sourceFixture(() => history.promise);
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => fixture.historySnapshot.mock.calls.length === 1);
    expect(fixture.order.slice(0, 3)).toEqual(['subscribe', 'demand:true', 'history']);
    fixture.output(event(2, 'two'));
    history.resolve(snapshot({ data: 'one', toSeq: 1 }));
    await until(() => states.at(-1)?.buffer === 'onetwo');

    expect(states.at(-1)).toMatchObject({ buffer: 'onetwo', toSeq: 2, status: 'ready' });
    connection.dispose();
  });

  it('does not duplicate a live event already covered by the authoritative snapshot', async () => {
    const history = deferred<TerminalHistorySnapshot | null>();
    const fixture = sourceFixture(() => history.promise);
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => fixture.historySnapshot.mock.calls.length === 1);
    fixture.output(event(2, 'two'));
    history.resolve(snapshot({ data: 'onetwo', toSeq: 2 }));
    await until(() => states.at(-1)?.status === 'ready');

    expect(states.at(-1)).toMatchObject({ buffer: 'onetwo', toSeq: 2 });
    connection.dispose();
  });

  it('requests a fresh full history when a live sequence gap is observed', async () => {
    const snapshots = [
      snapshot({ data: 'one', toSeq: 1 }),
      snapshot({ data: 'one two three', toSeq: 3 })
    ];
    const fixture = sourceFixture(async () => snapshots.shift() ?? null);
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => states.at(-1)?.toSeq === 1);
    fixture.output(event(3, 'three'));
    await until(() => states.at(-1)?.toSeq === 3);

    expect(fixture.historySnapshot).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.buffer).toBe('one two three');
    connection.dispose();
  });

  it('stops demand while hidden and takes a new snapshot on reveal', async () => {
    const fixture = sourceFixture(async () => snapshot({ data: 'current', toSeq: 4 }));
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect(() => undefined, false);

    await Promise.resolve();
    expect(fixture.historySnapshot).not.toHaveBeenCalled();
    connection.setVisible(true);
    await until(() => fixture.historySnapshot.mock.calls.length === 1);
    connection.setVisible(false);
    await until(() => fixture.setOutputDemand.mock.calls.at(-1)?.[1] === false);
    connection.setVisible(true);
    await until(() => fixture.historySnapshot.mock.calls.length === 2);

    expect(fixture.setOutputDemand.mock.calls.map((call) => call[1])).toEqual([
      true,
      false,
      true
    ]);
    connection.dispose();
  });
});

function sourceFixture(history: () => Promise<TerminalHistorySnapshot | null>) {
  let outputListener: ((event: TerminalOutputEvent) => void) | null = null;
  const order: string[] = [];
  const historySnapshot = vi.fn(async () => {
    order.push('history');
    return history();
  });
  const setOutputDemand = vi.fn(async (_terminalId: string, active: boolean) => {
    order.push(`demand:${active}`);
  });
  const source: TerminalSessionSource = {
    subscribeOutput: (listener) => {
      order.push('subscribe');
      outputListener = listener;
      return () => {
        outputListener = null;
      };
    },
    historySnapshot,
    setOutputDemand
  };
  return {
    source,
    order,
    historySnapshot,
    setOutputDemand,
    output: (event: TerminalOutputEvent) => outputListener?.(event)
  };
}

function snapshot(overrides: Partial<TerminalHistorySnapshot> = {}): TerminalHistorySnapshot {
  return {
    kind: 'ghostty-vt-history-v1',
    terminalId: 'terminal-1',
    sessionId: 'session-1',
    cols: 120,
    rows: 30,
    data: '',
    fromSeq: 1,
    toSeq: 0,
    truncated: false,
    byteLength: 0,
    ...overrides
  };
}

function event(seq: number, data: string): TerminalOutputEvent {
  return { terminalId: 'terminal-1', sessionId: 'session-1', seq, data };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition did not become true');
}
