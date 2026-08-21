// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { attachTerminalTouchScroll } from './terminal-touch-scroll';

describe('attachTerminalTouchScroll', () => {
  it('continues scrolling with decaying momentum after a swipe ends', () => {
    const target = document.createElement('div');
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let now = 0;
    const scrollLines = vi.fn();
    const detach = attachTerminalTouchScroll({
      target,
      scrollLines,
      rowHeight: () => 1,
      scheduler: {
        now: () => now,
        requestFrame(callback) {
          const handle = nextFrame++;
          frames.set(handle, callback);
          return handle;
        },
        cancelFrame: (handle) => frames.delete(handle)
      }
    });

    dispatchTouch(target, 'touchstart', [{ identifier: 1, clientY: 300 }]);
    now = 50;
    const move = dispatchTouch(target, 'touchmove', [{ identifier: 1, clientY: 220 }]);
    expect(move.defaultPrevented).toBe(true);
    expect(scrollLines).toHaveBeenCalled();

    scrollLines.mockClear();
    dispatchTouch(target, 'touchend', []);
    expect(frames.size).toBe(1);

    now = 66;
    runNextFrame(frames, now);
    expect(scrollLines).toHaveBeenCalledWith(expect.any(Number));
    const firstMomentumStep = scrollLines.mock.calls[0]?.[0] as number;
    expect(firstMomentumStep).toBeGreaterThan(0);
    expect(frames.size).toBe(1);

    now = 82;
    runNextFrame(frames, now);
    const secondMomentumStep = scrollLines.mock.calls[1]?.[0] as number;
    expect(secondMomentumStep).toBeGreaterThan(0);
    expect(secondMomentumStep).toBeLessThan(firstMomentumStep);

    detach();
    expect(frames.size).toBe(0);
  });

  it('leaves a tap alone so xterm can focus its input', () => {
    const target = document.createElement('div');
    const scrollLines = vi.fn();
    const detach = attachTerminalTouchScroll({
      target,
      scrollLines,
      rowHeight: () => 20
    });

    const start = dispatchTouch(target, 'touchstart', [{ identifier: 1, clientY: 200 }]);
    const end = dispatchTouch(target, 'touchend', []);

    expect(start.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(scrollLines).not.toHaveBeenCalled();
    detach();
  });
});

function dispatchTouch(
  target: HTMLElement,
  type: 'touchstart' | 'touchmove' | 'touchend',
  touches: Array<{ identifier: number; clientY: number }>
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: touches }
  });
  target.dispatchEvent(event);
  return event;
}

function runNextFrame(frames: Map<number, FrameRequestCallback>, now: number): void {
  const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
  if (!entry) throw new Error('Expected a queued animation frame.');
  frames.delete(entry[0]);
  entry[1](now);
}
