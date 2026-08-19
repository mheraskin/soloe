import { describe, expect, it, vi } from 'vitest';
import { scheduleTerminalViewportSnap } from './terminal-viewport-snap';

describe('scheduleTerminalViewportSnap', () => {
  it('snaps immediately, after layout, and after the mobile viewport settles', () => {
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, () => void>();
    let nextHandle = 1;
    const snap = vi.fn();
    const cancel = scheduleTerminalViewportSnap(snap, {
      requestFrame(callback) {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle) => frames.delete(handle),
      setTimer(callback) {
        const handle = nextHandle++;
        timers.set(handle, callback);
        return handle;
      },
      clearTimer: (handle) => timers.delete(handle)
    });

    expect(snap).toHaveBeenCalledTimes(1);

    const firstFrame = frames.values().next().value!;
    frames.clear();
    firstFrame(0);
    const secondFrame = frames.values().next().value!;
    frames.clear();
    secondFrame(0);
    expect(snap).toHaveBeenCalledTimes(2);

    timers.values().next().value!();
    expect(snap).toHaveBeenCalledTimes(3);

    cancel();
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
  });
});
