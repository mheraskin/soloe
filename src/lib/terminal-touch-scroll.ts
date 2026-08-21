const DRAG_THRESHOLD_PX = 4;
const MIN_MOMENTUM_PX_PER_MS = 0.02;
const MAX_MOMENTUM_PX_PER_MS = 3;
const MOMENTUM_RETAINED_PER_FRAME = 0.92;
const FRAME_MS = 1000 / 60;

interface TerminalTouchScrollScheduler {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

interface TerminalTouchScrollOptions {
  target: HTMLElement;
  scrollLines(lines: number): void;
  rowHeight(): number;
  scheduler?: TerminalTouchScrollScheduler;
}

export function attachTerminalTouchScroll({
  target,
  scrollLines,
  rowHeight,
  scheduler = {
    now: () => performance.now(),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle)
  }
}: TerminalTouchScrollOptions): () => void {
  let touchId: number | null = null;
  let startY = 0;
  let lastY = 0;
  let lastTouchAt = 0;
  let dragging = false;
  let velocity = 0;
  let pixelRemainder = 0;
  let momentumFrame = 0;
  let lastMomentumAt = 0;

  const stopMomentum = (): void => {
    if (momentumFrame) scheduler.cancelFrame(momentumFrame);
    momentumFrame = 0;
    velocity = 0;
  };

  const applyPixels = (pixels: number): void => {
    const height = Math.max(1, rowHeight());
    pixelRemainder += pixels;
    const lines = pixelRemainder > 0
      ? Math.floor(pixelRemainder / height)
      : Math.ceil(pixelRemainder / height);
    if (lines === 0) return;
    pixelRemainder -= lines * height;
    scrollLines(lines);
  };

  const runMomentum = (timestamp: number): void => {
    momentumFrame = 0;
    const elapsed = Math.min(32, Math.max(1, timestamp - lastMomentumAt));
    lastMomentumAt = timestamp;
    applyPixels(velocity * elapsed);
    velocity *= Math.pow(MOMENTUM_RETAINED_PER_FRAME, elapsed / FRAME_MS);
    if (Math.abs(velocity) < MIN_MOMENTUM_PX_PER_MS) {
      velocity = 0;
      return;
    }
    momentumFrame = scheduler.requestFrame(runMomentum);
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) return;
    stopMomentum();
    const touch = event.touches[0];
    if (!touch) return;
    touchId = touch.identifier;
    startY = touch.clientY;
    lastY = touch.clientY;
    lastTouchAt = scheduler.now();
    dragging = false;
    pixelRemainder = 0;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (touchId === null) return;
    const touch = findTouch(event.touches, touchId);
    if (!touch) return;
    const now = scheduler.now();
    const delta = lastY - touch.clientY;
    const elapsed = Math.max(1, now - lastTouchAt);
    const dragDistance = startY - touch.clientY;
    const startedDragging = !dragging && Math.abs(dragDistance) >= DRAG_THRESHOLD_PX;
    if (startedDragging) dragging = true;
    lastY = touch.clientY;
    lastTouchAt = now;
    const nextVelocity = clamp(delta / elapsed, -MAX_MOMENTUM_PX_PER_MS, MAX_MOMENTUM_PX_PER_MS);
    velocity = velocity === 0 ? nextVelocity : velocity * 0.35 + nextVelocity * 0.65;
    if (!dragging) return;

    event.preventDefault();
    event.stopPropagation();
    applyPixels(startedDragging ? dragDistance : delta);
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (touchId === null) return;
    const wasDragging = dragging;
    touchId = null;
    dragging = false;
    if (!wasDragging) return;

    event.preventDefault();
    event.stopPropagation();
    if (Math.abs(velocity) < MIN_MOMENTUM_PX_PER_MS) return;
    lastMomentumAt = scheduler.now();
    momentumFrame = scheduler.requestFrame(runMomentum);
  };

  const onTouchCancel = (): void => {
    touchId = null;
    dragging = false;
    stopMomentum();
  };

  target.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  target.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  target.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  target.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });

  return () => {
    stopMomentum();
    target.removeEventListener('touchstart', onTouchStart, true);
    target.removeEventListener('touchmove', onTouchMove, true);
    target.removeEventListener('touchend', onTouchEnd, true);
    target.removeEventListener('touchcancel', onTouchCancel, true);
  };
}

function findTouch(touches: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.identifier === identifier) return touch;
  }
  return null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
