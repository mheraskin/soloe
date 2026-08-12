export interface NativeSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BLOCKING_PORTAL_SELECTOR = [
  '[data-slot="dialog-content"]:not([data-state="closed"])',
  '[data-slot="sheet-content"]:not([data-state="closed"])',
  '[data-slot="popover-content"]:not([data-state="closed"])',
  '[data-slot="dropdown-menu-content"]:not([data-state="closed"])',
  '[data-slot="dropdown-menu-sub-content"]:not([data-state="closed"])',
  '[data-slot="context-menu-content"]:not([data-state="closed"])',
  '[data-slot="context-menu-sub-content"]:not([data-state="closed"])',
  '[data-slot="select-content"]:not([data-state="closed"])'
].join(',');

let rendererZoom = 1;
let railResizing = false;
let portalOpen = false;
let blocked = false;
let observer: MutationObserver | null = null;
const blockerSubscribers = new Set<(blocked: boolean) => void>();

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

/** Converts WebView CSS pixels into the OS logical coordinates Tauri expects. */
export function nativeSurfaceBounds(
  rect: Pick<DOMRectReadOnly, 'x' | 'y' | 'width' | 'height'>
): NativeSurfaceBounds {
  return {
    x: rounded(rect.x * rendererZoom),
    y: rounded(rect.y * rendererZoom),
    width: rounded(rect.width * rendererZoom),
    height: rounded(rect.height * rendererZoom)
  };
}

export function setRendererZoom(next: number): void {
  const normalized = Number.isFinite(next) ? Math.max(0.25, Math.min(5, next)) : 1;
  if (normalized === rendererZoom) return;
  rendererZoom = normalized;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('soloe:renderer-zoom', { detail: { factor: rendererZoom } })
    );
  }
}

export function isNativeSurfaceBlocked(): boolean {
  return blockerSubscribers.size === 0 ? detectPortal() || railResizing : blocked;
}

/**
 * Native child windows cannot participate in the WebView's DOM z-index.
 * Hide them while a portalled control or a rail drag must receive input above
 * their placeholder, then restore them without touching the Session PTY.
 */
export function subscribeNativeSurfaceBlocker(
  subscriber: (nextBlocked: boolean) => void
): () => void {
  blockerSubscribers.add(subscriber);
  if (blockerSubscribers.size === 1) attachBlockerObservation();
  subscriber(blocked);
  return () => {
    blockerSubscribers.delete(subscriber);
    if (blockerSubscribers.size === 0) detachBlockerObservation();
  };
}

function detectPortal(): boolean {
  return typeof document !== 'undefined' && document.querySelector(BLOCKING_PORTAL_SELECTOR) !== null;
}

function refreshBlocked(): void {
  portalOpen = detectPortal();
  const next = portalOpen || railResizing;
  if (next === blocked) return;
  blocked = next;
  for (const subscriber of blockerSubscribers) subscriber(blocked);
}

function onRailResizeStart(): void {
  railResizing = true;
  refreshBlocked();
}

function onRailResizeEnd(): void {
  railResizing = false;
  refreshBlocked();
}

function attachBlockerObservation(): void {
  portalOpen = detectPortal();
  blocked = portalOpen || railResizing;
  if (typeof document !== 'undefined') {
    observer = new MutationObserver(refreshBlocked);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state']
    });
  }
  window.addEventListener('soloe:rail-resize-start', onRailResizeStart);
  window.addEventListener('soloe:rail-resize-end', onRailResizeEnd);
}

function detachBlockerObservation(): void {
  observer?.disconnect();
  observer = null;
  window.removeEventListener('soloe:rail-resize-start', onRailResizeStart);
  window.removeEventListener('soloe:rail-resize-end', onRailResizeEnd);
  railResizing = false;
  portalOpen = false;
  blocked = false;
}
