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

  it('coalesces layout fits into the next frame and reports the final size', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const terminal = { cols: 80, rows: 24, refresh: vi.fn() };
    const fit = {
      fit: vi.fn(() => {
        terminal.cols = 132;
        terminal.rows = 46;
      })
    };
    const onFit = vi.fn();
    const controller = new TerminalFitController(
      (callback) => {
        const handle = nextFrame++;
        frames.set(handle, callback);
        return handle;
      },
      (handle) => {
        frames.delete(handle);
      }
    );

    controller.scheduleFit(terminal, fit, () => true, onFit);
    controller.scheduleFit(terminal, fit, () => true, onFit);

    expect(frames.size).toBe(1);
    expect(fit.fit).not.toHaveBeenCalled();
    const scheduled = frames.entries().next().value as [number, FrameRequestCallback];
    frames.delete(scheduled[0]);
    scheduled[1](0);

    expect(fit.fit).toHaveBeenCalledOnce();
    expect(onFit).toHaveBeenCalledWith({ cols: 132, rows: 46 });
  });

  it('does not starve redraws while layout fits continue every frame', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const terminal = { cols: 80, rows: 24, refresh: vi.fn() };
    const fit = {
      fit: vi.fn(() => {
        terminal.cols += 1;
      })
    };
    const controller = new TerminalFitController(
      (callback) => {
        const handle = nextFrame++;
        frames.set(handle, callback);
        return handle;
      },
      (handle) => {
        frames.delete(handle);
      }
    );
    const runFrame = () => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    };

    controller.scheduleFit(terminal, fit);
    runFrame();
    controller.scheduleFit(terminal, fit);
    runFrame();

    expect(fit.fit).toHaveBeenCalledTimes(2);
    expect(terminal.refresh).toHaveBeenCalledWith(0, 23);
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
