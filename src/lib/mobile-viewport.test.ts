// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachMobileViewport } from './mobile-viewport';

interface MutableVisualViewport {
  height: number;
  offsetTop: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

describe('attachMobileViewport', () => {
  let viewport: MutableVisualViewport;

  beforeEach(() => {
    viewport = {
      height: 810,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport
    });
  });

  afterEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-mobile-keyboard-open');
    vi.restoreAllMocks();
  });

  it('uses the full window height for an installed standalone PWA', () => {
    mockDisplayMode(true);

    const detach = attachMobileViewport();

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px');
    expect(document.documentElement.hasAttribute('data-mobile-keyboard-open')).toBe(false);
    detach();
  });

  it('keeps using the visual viewport while Safari chrome is present', () => {
    mockDisplayMode(false);

    const detach = attachMobileViewport();

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('810px');
    detach();
  });

  it('keeps the standalone layout height stable while the keyboard opens', () => {
    mockDisplayMode(true);
    const detach = attachMobileViewport();
    viewport.height = 600;
    dispatchViewportResize(viewport);

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('844px');
    expect(document.documentElement.hasAttribute('data-mobile-keyboard-open')).toBe(true);
    detach();
  });

  it('keeps the Safari layout height stable while the keyboard opens', () => {
    mockDisplayMode(false);
    const detach = attachMobileViewport();
    viewport.height = 600;
    dispatchViewportResize(viewport);

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('810px');
    expect(document.documentElement.hasAttribute('data-mobile-keyboard-open')).toBe(true);
    detach();
  });
});

function mockDisplayMode(standalone: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(display-mode: standalone)' && standalone,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
}

function dispatchViewportResize(viewport: MutableVisualViewport): void {
  const call = viewport.addEventListener.mock.calls.find(([type]) => type === 'resize');
  const listener = call?.[1] as EventListener | undefined;
  listener?.(new Event('resize'));
}
