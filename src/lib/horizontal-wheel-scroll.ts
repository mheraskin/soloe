const WHEEL_LINE_PIXELS = 16;

export function scrollHorizontalWheel(viewport: HTMLElement, event: WheelEvent): void {
  const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  if (
    maxScrollLeft === 0
    || event.deltaY === 0
    || Math.abs(event.deltaX) >= Math.abs(event.deltaY)
  ) {
    return;
  }

  const delta = verticalDeltaPixels(viewport, event);
  const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, viewport.scrollLeft + delta));
  if (nextScrollLeft === viewport.scrollLeft) return;

  viewport.scrollLeft = nextScrollLeft;
  event.preventDefault();
}

function verticalDeltaPixels(viewport: HTMLElement, event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * WHEEL_LINE_PIXELS;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * viewport.clientWidth;
  return event.deltaY;
}
