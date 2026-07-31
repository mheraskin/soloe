export type PageZoomDirection = 'in' | 'out' | 'reset';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

export function changePageZoom(
  direction: PageZoomDirection,
  root: HTMLElement = document.documentElement
): number {
  const current = Number.parseFloat(root.style.zoom) || 1;
  const requested = direction === 'reset'
    ? 1
    : current + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP);
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(requested * 10) / 10));

  root.style.zoom = next === 1 ? '' : String(next);
  window.dispatchEvent(new CustomEvent('soloe:rail-layout'));
  return next;
}
