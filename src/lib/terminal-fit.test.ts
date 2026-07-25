import { describe, expect, it, vi } from 'vitest';
import { deferTerminalDispose, TerminalFitController } from './terminal-fit';

describe('TerminalFitController', () => {
  it('redraws only after the fit has settled into the next frame', () => {
    const calls: string[] = [];
    const redraws: FrameRequestCallback[] = [];
    const terminal = {
      cols: 80,
      rows: 24,
      refresh: vi.fn((start: number, end: number) => {
        calls.push(`refresh:${start}:${end}`);
      })
    };
    const fit = {
      fit: vi.fn(() => {
        calls.push('fit');
        terminal.cols = 120;
        terminal.rows = 40;
      })
    };
    const controller = new TerminalFitController(
      (callback) => {
        redraws.push(callback);
        return 1;
      },
      vi.fn()
    );

    expect(controller.fit(terminal, fit)).toEqual({ cols: 120, rows: 40 });
    expect(calls).toEqual(['fit']);

    redraws[0]!(0);
    expect(calls).toEqual(['fit', 'refresh:0:39']);
  });

  it('cancels a stale redraw before terminal teardown', () => {
    const redraws: FrameRequestCallback[] = [];
    const cancelFrame = vi.fn();
    const terminal = { cols: 80, rows: 24, refresh: vi.fn() };
    const controller = new TerminalFitController(
      (callback) => {
        redraws.push(callback);
        return 7;
      },
      cancelFrame
    );

    controller.fit(terminal, { fit: vi.fn() });
    controller.cancel();
    redraws[0]!(0);

    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(terminal.refresh).not.toHaveBeenCalled();
  });
});

describe('deferTerminalDispose', () => {
  it('keeps xterm alive through its queued viewport initialization callback', () => {
    const terminal = { dispose: vi.fn() };
    const disposeCallbacks: Array<() => void> = [];

    deferTerminalDispose(terminal, (callback) => {
      disposeCallbacks.push(callback);
    });

    expect(terminal.dispose).not.toHaveBeenCalled();
    disposeCallbacks[0]!();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });
});
