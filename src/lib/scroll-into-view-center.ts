// Smart vertical scrolling: if an element is fully visible inside its
// scrollable viewport, do nothing. Otherwise, scroll the viewport so the
// element sits at the vertical centre of the visible area.
//
// Caller passes the scroll viewport element explicitly because the sidebar
// uses a custom scrollable container (bits-ui ScrollArea) where the nearest
// `overflow: scroll` ancestor is not the element we want to drive.

const VISIBILITY_PADDING = 8;

export function scrollIntoViewCentered(
  element: HTMLElement,
  viewport: HTMLElement,
  options: { behavior?: ScrollBehavior } = {}
): void {
  const behavior = options.behavior ?? 'smooth';
  const elRect = element.getBoundingClientRect();
  const vpRect = viewport.getBoundingClientRect();

  const fullyAbove = elRect.top < vpRect.top + VISIBILITY_PADDING;
  const fullyBelow = elRect.bottom > vpRect.bottom - VISIBILITY_PADDING;
  if (!fullyAbove && !fullyBelow) return;

  // Convert element top from viewport-coords to scroll-coords, then offset so
  // the element's centre lines up with the viewport's centre.
  const elTopInScroll = elRect.top - vpRect.top + viewport.scrollTop;
  const elCentre = elTopInScroll + elRect.height / 2;
  const target = Math.max(0, elCentre - vpRect.height / 2);
  viewport.scrollTo({ top: target, behavior });
}
