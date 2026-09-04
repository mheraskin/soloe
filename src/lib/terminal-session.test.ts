import { describe, expect, it, vi } from 'vitest';
import type { TerminalHistorySnapshot, TerminalOutputEvent } from '@shared/types/terminal.js';
import {
  MAX_TERMINAL_PRESENTATION_PENDING_BYTES,
  MAX_TERMINAL_PRESENTATION_PENDING_EVENTS,
  TerminalHistorySession,
  terminalPresentationUpdates,
  type TerminalPresentationCursor,
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
    await until(() => states.at(-1)?.toSeq === 2);

    expect(presentationText(states.at(-1)!)).toBe('onetwo');
    expect(states.at(-1)).toMatchObject({
      reset: { data: 'one', toSeq: 1 },
      tail: [{ data: 'two', seq: 2 }],
      toSeq: 2,
      status: { kind: 'ready' }
    });
    expect(states.at(-1)).not.toHaveProperty('buffer');
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
    await until(() => states.at(-1)?.status.kind === 'ready');

    expect(states.at(-1)).toMatchObject({
      reset: { data: 'onetwo', toSeq: 2 },
      tail: [],
      toSeq: 2
    });
    connection.dispose();
  });

  it('continues with live output after the server discards an oversized replay', async () => {
    const history = deferred<TerminalHistorySnapshot | null>();
    const fixture = sourceFixture(() => history.promise);
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => fixture.historySnapshot.mock.calls.length === 1);
    fixture.output(event(43, 'live output'));
    history.resolve(snapshot({
      data: '',
      fromSeq: 43,
      toSeq: 42,
      truncated: true,
      byteLength: 0
    }));
    await until(() => states.at(-1)?.toSeq === 43);

    expect(states.at(-1)).toMatchObject({
      reset: { data: '', fromSeq: 43, toSeq: 42 },
      tail: [{ data: 'live output', seq: 43 }],
      toSeq: 43,
      status: { kind: 'ready', truncated: true }
    });
    expect(presentationText(states.at(-1)!)).toBe('live output');
    expect(fixture.historySnapshot).toHaveBeenCalledOnce();
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
    expect(presentationText(states.at(-1)!)).toBe('one two three');
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

  it('keeps output demand enabled when a delayed hide completes after reveal', async () => {
    const hide = deferred<void>();
    const completed: boolean[] = [];
    let serverDemand = false;
    const fixture = sourceFixture(
      async () => snapshot({ data: 'ready', toSeq: 1 }),
      async (active) => {
        if (!active) await hide.promise;
        serverDemand = active;
        completed.push(active);
      }
    );
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => serverDemand);
    connection.setVisible(false);
    await until(() => fixture.setOutputDemand.mock.calls.some((call) => call[1] === false));
    connection.setVisible(true);
    await Promise.resolve();
    hide.resolve();
    await until(() => completed.includes(false));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(serverDemand).toBe(true);
    if (serverDemand) fixture.output(event(2, 'few words'));
    expect(presentationText(states.at(-1)!)).toBe('readyfew words');
    connection.dispose();
  });

  it('leaves output demand disabled when disposal races a pending enable', async () => {
    const enable = deferred<void>();
    const completed: boolean[] = [];
    let serverDemand = false;
    const fixture = sourceFixture(
      async () => snapshot(),
      async (active) => {
        if (active) await enable.promise;
        serverDemand = active;
        completed.push(active);
      }
    );
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect(() => undefined, true);

    await until(() => fixture.setOutputDemand.mock.calls.some((call) => call[1] === true));
    connection.dispose();
    enable.resolve();
    await until(() => completed.includes(true) && completed.includes(false));

    expect(serverDemand).toBe(false);
  });

  it('keeps a bounded live tail and turns a lagging presentation into resync', async () => {
    const fixture = sourceFixture(async () => snapshot());
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => states.at(-1)?.status.kind === 'ready');
    for (let seq = 1; seq <= MAX_TERMINAL_PRESENTATION_PENDING_EVENTS + 1; seq += 1) {
      fixture.output(event(seq, 'x'));
    }

    const latest = states.at(-1)!;
    expect(latest.tail).toHaveLength(MAX_TERMINAL_PRESENTATION_PENDING_EVENTS);
    expect(latest.tail[0]?.seq).toBe(2);
    expect(latest.byteLength).toBe(MAX_TERMINAL_PRESENTATION_PENDING_EVENTS);
    expect(terminalPresentationUpdates(latest, presentationCursor(0, 0))).toEqual([
      { kind: 'resync' }
    ]);
    connection.dispose();
  });

  it('bounds the live tail by bytes without splitting output events', async () => {
    const fixture = sourceFixture(async () => snapshot());
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);
    const chunk = 'x'.repeat(Math.floor(MAX_TERMINAL_PRESENTATION_PENDING_BYTES / 2) + 1);

    await until(() => states.at(-1)?.status.kind === 'ready');
    fixture.output(event(1, chunk));
    fixture.output(event(2, chunk));

    expect(states.at(-1)?.tail).toEqual([event(2, chunk)]);
    expect(states.at(-1)?.byteLength).toBe(chunk.length);
    expect(terminalPresentationUpdates(
      states.at(-1)!,
      presentationCursor(0, 0)
    )).toEqual([{ kind: 'resync' }]);
    connection.dispose();
  });

  it('lets two attachments advance independently through one bounded delivery state', async () => {
    const fixture = sourceFixture(async () => snapshot({ data: 'one', toSeq: 1 }));
    const firstStates: TerminalSessionState[] = [];
    const secondStates: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const first = session.connect((state) => firstStates.push(state), true);
    const second = session.connect((state) => secondStates.push(state), true);

    await until(() => firstStates.at(-1)?.status.kind === 'ready');
    const initial = firstStates.at(-1)!;
    const firstCursor = applyUpdates(initial, presentationCursor(-1, 0));
    fixture.output(event(2, 'two'));
    fixture.output(event(3, 'three'));
    const latest = firstStates.at(-1)!;

    expect(terminalPresentationUpdates(latest, firstCursor).map((item) => item.kind)).toEqual([
      'append',
      'append'
    ]);
    expect(terminalPresentationUpdates(
      secondStates.at(-1)!,
      presentationCursor(-1, 0)
    ).map((item) => item.kind)).toEqual(['reset', 'append', 'append']);
    first.dispose();
    second.dispose();
  });

  it('resets a presentation when terminal identity changes at the same generation', async () => {
    const fixture = sourceFixture(async () => snapshot({ data: 'second terminal', toSeq: 1 }));
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-2', 'session-2', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => states.at(-1)?.status.kind === 'ready');

    expect(terminalPresentationUpdates(states.at(-1)!, {
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      generation: 1,
      toSeq: 1
    }).map((item) => item.kind)).toEqual(['reset']);
    connection.dispose();
  });

  it('bounds output received while a snapshot is pending and retries from authority', async () => {
    const firstHistory = deferred<TerminalHistorySnapshot | null>();
    let calls = 0;
    const fixture = sourceFixture(async () => {
      calls += 1;
      if (calls === 1) return firstHistory.promise;
      return snapshot({ data: 'authoritative', toSeq: MAX_TERMINAL_PRESENTATION_PENDING_EVENTS + 1 });
    });
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => fixture.historySnapshot.mock.calls.length === 1);
    for (let seq = 1; seq <= MAX_TERMINAL_PRESENTATION_PENDING_EVENTS + 1; seq += 1) {
      fixture.output(event(seq, 'x'));
    }
    firstHistory.resolve(snapshot());
    await until(() => fixture.historySnapshot.mock.calls.length === 2);
    await until(() => states.at(-1)?.reset.data === 'authoritative');

    expect(states.at(-1)?.tail).toEqual([]);
    connection.dispose();
  });

  it('does not retain one oversized event while a snapshot is pending', async () => {
    const firstHistory = deferred<TerminalHistorySnapshot | null>();
    let calls = 0;
    const fixture = sourceFixture(async () => {
      calls += 1;
      if (calls === 1) return firstHistory.promise;
      return snapshot({ data: 'bounded snapshot', toSeq: 1 });
    });
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => fixture.historySnapshot.mock.calls.length === 1);
    fixture.output(event(1, 'x'.repeat(MAX_TERMINAL_PRESENTATION_PENDING_BYTES + 1)));
    firstHistory.resolve(snapshot());
    await until(() => fixture.historySnapshot.mock.calls.length === 2);
    await until(() => states.at(-1)?.reset.data === 'bounded snapshot');

    expect(states.at(-1)?.tail).toEqual([]);
    connection.dispose();
  });

  it('recovers an oversized live event through a bounded snapshot', async () => {
    let calls = 0;
    const fixture = sourceFixture(async () => {
      calls += 1;
      return calls === 1
        ? snapshot()
        : snapshot({ data: 'bounded live recovery', toSeq: 1 });
    });
    const states: TerminalSessionState[] = [];
    const session = new TerminalHistorySession('terminal-1', 'session-1', fixture.source);
    const connection = session.connect((state) => states.push(state), true);

    await until(() => states.at(-1)?.status.kind === 'ready');
    fixture.output(event(1, 'x'.repeat(MAX_TERMINAL_PRESENTATION_PENDING_BYTES + 1)));
    await until(() => fixture.historySnapshot.mock.calls.length === 2);
    await until(() => states.at(-1)?.reset.data === 'bounded live recovery');

    expect(states.at(-1)?.tail).toEqual([]);
    connection.dispose();
  });
});

function presentationText(state: TerminalSessionState): string {
  return `${state.reset.data}${state.tail.map((item) => item.data).join('')}`;
}

function applyUpdates(
  state: TerminalSessionState,
  cursor: TerminalPresentationCursor
): TerminalPresentationCursor {
  let next = cursor;
  for (const update of terminalPresentationUpdates(state, cursor)) {
    if (update.kind === 'resync') return next;
    next = update.kind === 'reset'
      ? {
          terminalId: state.terminalId,
          sessionId: state.sessionId,
          generation: update.reset.generation,
          toSeq: update.reset.toSeq
        }
      : { ...next, toSeq: update.event.seq };
  }
  return next;
}

function presentationCursor(
  generation: number,
  toSeq: number,
  terminalId: TerminalPresentationCursor['terminalId'] = 'terminal-1',
  sessionId: TerminalPresentationCursor['sessionId'] = 'session-1'
): TerminalPresentationCursor {
  return { terminalId, sessionId, generation, toSeq };
}

function sourceFixture(
  history: () => Promise<TerminalHistorySnapshot | null>,
  demand: (active: boolean) => Promise<void> = async () => undefined
) {
  let outputListener: ((event: TerminalOutputEvent) => void) | null = null;
  const order: string[] = [];
  const historySnapshot = vi.fn(async () => {
    order.push('history');
    return history();
  });
  const setOutputDemand = vi.fn(async (_terminalId: string, active: boolean) => {
    order.push(`demand:${active}`);
    await demand(active);
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
