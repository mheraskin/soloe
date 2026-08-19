const MOBILE_WORKSPACE_TRANSITION_SETTLE_MS = 280;

interface MobileWorkspaceLayoutScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(handle: number): void;
}

export function scheduleMobileWorkspaceRefresh(
  notify: () => void,
  scheduler: MobileWorkspaceLayoutScheduler = {
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (handle) => window.clearTimeout(handle)
  }
): () => void {
  let settledFrame = 0;
  const initialFrame = scheduler.requestFrame(() => {
    settledFrame = scheduler.requestFrame(() => notify());
  });
  const transitionTimer = scheduler.setTimer(
    notify,
    MOBILE_WORKSPACE_TRANSITION_SETTLE_MS
  );

  return () => {
    scheduler.cancelFrame(initialFrame);
    if (settledFrame) scheduler.cancelFrame(settledFrame);
    scheduler.clearTimer(transitionTimer);
  };
}
