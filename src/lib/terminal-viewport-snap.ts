const TERMINAL_VIEWPORT_SETTLE_MS = 280;

export interface TerminalViewportSnapScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(handle: number): void;
}

/**
 * Keep the terminal prompt visible while a mobile browser animates its visual
 * viewport. Every pass is a direct xterm snap; the timer only waits for Safari
 * to publish its final viewport size and does not animate the scroll itself.
 */
export function scheduleTerminalViewportSnap(
  snap: () => void,
  scheduler: TerminalViewportSnapScheduler = {
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (handle) => window.clearTimeout(handle)
  }
): () => void {
  snap();

  let settledFrame = 0;
  const initialFrame = scheduler.requestFrame(() => {
    settledFrame = scheduler.requestFrame(snap);
  });
  const transitionTimer = scheduler.setTimer(snap, TERMINAL_VIEWPORT_SETTLE_MS);

  return () => {
    scheduler.cancelFrame(initialFrame);
    if (settledFrame) scheduler.cancelFrame(settledFrame);
    scheduler.clearTimer(transitionTimer);
  };
}
