// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { scrollHorizontalWheel } from './horizontal-wheel-scroll';

describe('scrollHorizontalWheel', () => {
  it('uses a vertical mouse wheel to reveal horizontally overflowing content', () => {
    const viewport = overflowingViewport();
    const event = wheelEvent({ deltaY: 120 });

    scrollHorizontalWheel(viewport, event);

    expect(viewport.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves native horizontal trackpad gestures alone', () => {
    const viewport = overflowingViewport();
    const event = wheelEvent({ deltaX: 80, deltaY: 20 });

    scrollHorizontalWheel(viewport, event);

    expect(viewport.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not trap vertical scrolling when the strip cannot move further', () => {
    const viewport = overflowingViewport();
    viewport.scrollLeft = 300;
    const event = wheelEvent({ deltaY: 120 });

    scrollHorizontalWheel(viewport, event);

    expect(viewport.scrollLeft).toBe(300);
    expect(event.defaultPrevented).toBe(false);
  });
});

function overflowingViewport(): HTMLElement {
  const viewport = document.createElement('div');
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 500 }
  });
  return viewport;
}

function wheelEvent(init: WheelEventInit): WheelEvent {
  return new WheelEvent('wheel', { cancelable: true, ...init });
}
