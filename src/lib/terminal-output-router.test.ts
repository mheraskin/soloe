import { describe, expect, it, vi } from 'vitest';
import type { TerminalOutputEvent, TerminalReplaySnapshot } from '@shared/types/terminal.js';
import {
  TerminalOutputRouter,
  type TerminalPresentationSink
} from './terminal-output-router';

describe('TerminalOutputRouter', () => {
  it('keeps hidden presentations fully dormant', () => {
    const live = createLiveSource();
    const hiddenSink = createSink();
    const visibleSink = createSink();
    const router = new TerminalOutputRouter(live.source);

    router.attach('t-1', 's-1', hiddenSink, false);
    router.attach('t-1', 's-1', visibleSink, true);
    live.emit(event('t-1', 's-1', 1, 'sustained-output'));

    expect(visibleSink.write).toHaveBeenCalledWith('sustained-output');
    expect(hiddenSink.write).not.toHaveBeenCalled();
    expect(hiddenSink.replace).not.toHaveBeenCalled();
  });

  it('shares one live source and detaches it when the last presentation hides', () => {
    const live = createLiveSource();
    const router = new TerminalOutputRouter(live.source);
    const first = router.attach('t-1', 's-1', createSink(), false);
    const second = router.attach('t-2', 's-2', createSink(), true);

    expect(live.source).toHaveBeenCalledOnce();
    first.setVisible(true);
    expect(live.source).toHaveBeenCalledOnce();

    second.setVisible(false);
    expect(live.detach).not.toHaveBeenCalled();
    first.setVisible(false);
    expect(live.detach).toHaveBeenCalledOnce();
  });

  it('routes live output only to the exact terminal and Session', () => {
    const live = createLiveSource();
    const sink = createSink();
    const router = new TerminalOutputRouter(live.source);
    router.attach('t-1', 's-1', sink, true);

    live.emit(event('t-1', 'other-session', 1, 'wrong-session'));
    live.emit(event('t-2', 's-1', 1, 'wrong-terminal'));
    live.emit(event('t-1', 's-1', 1, 'correct'));

    expect(sink.write).toHaveBeenCalledOnce();
    expect(sink.write).toHaveBeenCalledWith('correct');
  });

  it('replays on reveal and bounds live overlap to sequence watermarks', async () => {
    const live = createLiveSource();
    const firstReplay = deferred<TerminalReplaySnapshot | null>();
    const replay = vi
      .fn()
      .mockReturnValueOnce(firstReplay.promise)
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 3, 3, 'three'));
    const sink = createSink();
    const router = new TerminalOutputRouter(live.source, replay);
    const presentation = router.attach('t-1', 's-1', sink, false);

    presentation.setVisible(true);
    expect(replay).toHaveBeenCalledWith('t-1', 0);
    live.emit(event('t-1', 's-1', 2, 'duplicate-live'));
    live.emit(event('t-1', 's-1', 3, 'three-live'));
    firstReplay.resolve(snapshot('t-1', 's-1', 1, 2, 'onetwo'));
    await settle();

    expect(replay).toHaveBeenNthCalledWith(2, 't-1', 2);
    expect(sink.write.mock.calls.map(([data]) => data)).toEqual(['onetwo', 'three']);

    live.emit(event('t-1', 's-1', 2, 'delayed-duplicate'));
    expect(sink.write).toHaveBeenCalledTimes(2);
  });

  it('commits a cursor only after xterm finishes an in-flight write', async () => {
    const live = createLiveSource();
    const initial = snapshot('t-1', 's-1', 1, 0, '');
    const replay = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 2, 2, 'b'));
    const firstWrite = deferred<void>();
    const sink = createSink();
    sink.write.mockReturnValueOnce(firstWrite.promise);
    const router = new TerminalOutputRouter(live.source, replay);
    const presentation = router.attach('t-1', 's-1', sink, true);
    await settle();

    live.emit(event('t-1', 's-1', 1, 'a'));
    presentation.setVisible(false);
    presentation.setVisible(true);
    expect(replay).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await settle();
    expect(replay).toHaveBeenNthCalledWith(2, 't-1', 1);
    expect(sink.write.mock.calls.map(([data]) => data)).toEqual(['a', 'b']);
  });

  it('invalidates a replay hidden before its result arrives', async () => {
    const live = createLiveSource();
    const firstReplay = deferred<TerminalReplaySnapshot | null>();
    const replay = vi
      .fn()
      .mockReturnValueOnce(firstReplay.promise)
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 1, 1, 'fresh'));
    const sink = createSink();
    const router = new TerminalOutputRouter(live.source, replay);
    const presentation = router.attach('t-1', 's-1', sink, false);

    presentation.setVisible(true);
    presentation.setVisible(false);
    firstReplay.resolve(snapshot('t-1', 's-1', 1, 1, 'stale'));
    await settle();
    expect(sink.write).not.toHaveBeenCalled();

    presentation.setVisible(true);
    await settle();
    expect(replay).toHaveBeenLastCalledWith('t-1', 0);
    expect(sink.write).toHaveBeenCalledWith('fresh');
  });

  it('resets and replaces terminal state when replay history was truncated', async () => {
    const replay = vi
      .fn()
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 10, 10, 'tail', true))
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 11, 10, ''));
    const replacement = deferred<void>();
    const sink = createSink();
    sink.replace.mockReturnValueOnce(replacement.promise);
    const router = new TerminalOutputRouter(() => vi.fn(), replay);

    const presentation = router.attach('t-1', 's-1', sink, true);
    await settle();

    expect(sink.write).not.toHaveBeenCalled();
    expect(sink.replace).toHaveBeenCalledOnce();
    const replacementText = sink.replace.mock.calls[0]?.[0] ?? '';
    expect(replacementText).toContain('[Earlier terminal output omitted to bound memory]');
    expect(replacementText.endsWith('tail')).toBe(true);

    presentation.setVisible(false);
    presentation.setVisible(true);
    expect(replay).toHaveBeenCalledTimes(1);
    replacement.resolve();
    await settle();
    expect(replay).toHaveBeenNthCalledWith(2, 't-1', 10);
  });

  it('recovers a visible sequence gap instead of applying corrupt output', async () => {
    const live = createLiveSource();
    const replay = vi
      .fn()
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 1, 0, ''))
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 1, 2, 'onetwo'));
    const sink = createSink();
    const router = new TerminalOutputRouter(live.source, replay);
    router.attach('t-1', 's-1', sink, true);
    await settle();

    live.emit(event('t-1', 's-1', 2, 'unsafe-two'));
    await settle();

    expect(replay).toHaveBeenLastCalledWith('t-1', 0);
    expect(sink.write).toHaveBeenCalledOnce();
    expect(sink.write).toHaveBeenCalledWith('onetwo');
  });

  it('replays visible terminals when the server transport reconnects', async () => {
    const reconnect = createReconnectSource();
    const replay = vi
      .fn()
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 1, 0, ''))
      .mockResolvedValueOnce(snapshot('t-1', 's-1', 1, 1, 'while-offline'));
    const sink = createSink();
    const router = new TerminalOutputRouter(
      createLiveSource().source,
      replay,
      undefined,
      reconnect.source
    );
    router.attach('t-1', 's-1', sink, true);
    await settle();

    reconnect.emit();
    await settle();

    expect(replay).toHaveBeenNthCalledWith(2, 't-1', 0);
    expect(sink.write).toHaveBeenCalledWith('while-offline');
  });

  it('serializes visible writes and coalesces output behind xterm', async () => {
    const live = createLiveSource();
    const firstWrite = deferred<void>();
    const sink = createSink();
    sink.write.mockReturnValueOnce(firstWrite.promise);
    const router = new TerminalOutputRouter(live.source);
    router.attach('t-1', 's-1', sink, true);

    live.emit(event('t-1', 's-1', 1, 'a'));
    live.emit(event('t-1', 's-1', 2, 'b'));
    live.emit(event('t-1', 's-1', 3, 'c'));
    expect(sink.write).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await settle();
    expect(sink.write.mock.calls.map(([data]) => data)).toEqual(['a', 'bc']);
  });

  it('rejects a mismatched replay snapshot and ignores replay after disposal', async () => {
    const wrongSnapshot = deferred<TerminalReplaySnapshot | null>();
    const wrongSink = createSink();
    const wrongRouter = new TerminalOutputRouter(
      () => vi.fn(),
      () => wrongSnapshot.promise
    );
    wrongRouter.attach('t-1', 's-1', wrongSink, true);
    wrongSnapshot.resolve(snapshot('t-1', 's-2', 1, 1, 'wrong'));
    await settle();
    expect(wrongSink.write).not.toHaveBeenCalled();

    const lateSnapshot = deferred<TerminalReplaySnapshot | null>();
    const lateSink = createSink();
    const lateRouter = new TerminalOutputRouter(() => vi.fn(), () => lateSnapshot.promise);
    const presentation = lateRouter.attach('t-2', 's-2', lateSink, true);
    presentation.dispose();
    lateSnapshot.resolve(snapshot('t-2', 's-2', 1, 1, 'late'));
    await settle();
    expect(lateSink.write).not.toHaveBeenCalled();
  });

  it('acquires transport on the first visible owner and releases it after the last', async () => {
    const demand = vi.fn(async (_terminalId: string, _active: boolean) => {});
    const router = new TerminalOutputRouter(createLiveSource().source, undefined, demand);
    const first = router.attach('t-1', 's-1', createSink(), true);
    const second = router.attach('t-1', 's-1', createSink(), true);
    await settle();

    expect(demand.mock.calls).toEqual([['t-1', true]]);
    first.setVisible(false);
    await settle();
    expect(demand.mock.calls).toEqual([['t-1', true]]);

    second.setVisible(false);
    await settle();
    expect(demand.mock.calls).toEqual([['t-1', true], ['t-1', false]]);
  });

  it('tracks transport ownership independently for visible terminals', async () => {
    const demand = vi.fn(async (_terminalId: string, _active: boolean) => {});
    const router = new TerminalOutputRouter(createLiveSource().source, undefined, demand);
    const first = router.attach('t-1', 's-1', createSink(), true);
    const second = router.attach('t-2', 's-2', createSink(), true);
    await settle();

    expect(demand.mock.calls).toEqual([['t-1', true], ['t-2', true]]);
    first.dispose();
    await settle();
    expect(demand.mock.calls).toContainEqual(['t-1', false]);
    expect(demand.mock.calls).not.toContainEqual(['t-2', false]);

    second.dispose();
    await settle();
    expect(demand.mock.calls).toContainEqual(['t-2', false]);
  });

  it('waits for transport acknowledgement before replay and retires a hidden acquisition', async () => {
    const acquisition = deferred<void>();
    const demand = vi
      .fn<(terminalId: string, active: boolean) => Promise<void>>()
      .mockReturnValueOnce(acquisition.promise)
      .mockResolvedValue(undefined);
    const replay = vi.fn(async () => snapshot('t-1', 's-1', 1, 1, 'late'));
    const sink = createSink();
    const router = new TerminalOutputRouter(createLiveSource().source, replay, demand);
    const presentation = router.attach('t-1', 's-1', sink, true);

    expect(replay).not.toHaveBeenCalled();
    presentation.setVisible(false);
    acquisition.resolve();
    await settle();

    expect(demand.mock.calls).toEqual([['t-1', true], ['t-1', false]]);
    expect(replay).not.toHaveBeenCalled();
    expect(sink.write).not.toHaveBeenCalled();
  });
});

function createSink() {
  const write = vi.fn<(data: string) => void | Promise<void>>();
  const replace = vi.fn<(data: string) => void | Promise<void>>();
  return { write, replace } satisfies TerminalPresentationSink;
}

function createLiveSource() {
  let listener: ((event: TerminalOutputEvent) => void) | null = null;
  const detach = vi.fn(() => {
    listener = null;
  });
  const source = vi.fn((next: (event: TerminalOutputEvent) => void) => {
    listener = next;
    return detach;
  });
  return {
    source,
    detach,
    emit: (value: TerminalOutputEvent) => listener?.(value)
  };
}

function createReconnectSource() {
  let listener: (() => void) | null = null;
  return {
    source: (next: () => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    emit: () => listener?.()
  };
}

function event(
  terminalId: string,
  sessionId: string,
  seq: number,
  data: string
): TerminalOutputEvent {
  return { terminalId, sessionId, seq, data };
}

function snapshot(
  terminalId: string,
  sessionId: string,
  fromSeq: number,
  toSeq: number,
  data: string,
  truncated = false
): TerminalReplaySnapshot {
  return { terminalId, sessionId, fromSeq, toSeq, data, truncated, byteLength: data.length };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
