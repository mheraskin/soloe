import { describe, expect, it, vi } from 'vitest';
import { scheduleMobileWorkspaceRefresh } from './mobile-workspace-layout';

describe('scheduleMobileWorkspaceRefresh', () => {
  it('refreshes once after layout and again after the mobile slide settles', () => {
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, () => void>();
    let nextHandle = 1;
    const notify = vi.fn();
    const cancel = scheduleMobileWorkspaceRefresh(notify, {
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

    const firstFrame = frames.values().next().value!;
    frames.clear();
    firstFrame(0);
    const secondFrame = frames.values().next().value!;
    frames.clear();
    secondFrame(0);
    expect(notify).toHaveBeenCalledTimes(1);

    timers.values().next().value!();
    expect(notify).toHaveBeenCalledTimes(2);

    cancel();
    expect(frames.size).toBe(0);
    expect(timers.size).toBe(0);
  });
});
