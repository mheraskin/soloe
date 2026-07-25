/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  estimateReviewBodyHeight,
  MAX_RESIDENT_REVIEW_SECTIONS,
  ReviewViewport
} from './review-viewport.svelte';
import type { FileDiff } from '@shared/types/git.js';

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe = (target: Element): void => {
    this.observed.add(target);
  };
  unobserve = (target: Element): void => {
    this.observed.delete(target);
  };
  disconnect = (): void => {
    this.observed.clear();
  };

  emit(target: Element, height: number): void {
    this.callback(
      [{ target, contentRect: { height } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
}

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  observed = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.instances.push(this);
  }

  observe = (target: Element): void => {
    this.observed.add(target);
  };
  unobserve = (target: Element): void => {
    this.observed.delete(target);
  };
  disconnect = (): void => {
    this.observed.clear();
  };

  emit(entries: Array<{ target: Element; isIntersecting: boolean }>): void {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

describe('ReviewViewport', () => {
  beforeEach(() => {
    TestResizeObserver.instances = [];
    TestIntersectionObserver.instances = [];
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    vi.stubGlobal('requestAnimationFrame', undefined);
  });

  it('shares one observation path and caps resident file bodies', async () => {
    const viewport = document.createElement('div');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 640 });
    const addListener = vi.spyOn(viewport, 'addEventListener');
    const module = new ReviewViewport();
    const detach = module.attach(viewport);
    const sections = Array.from({ length: 40 }, (_, index) => {
      const section = document.createElement('section');
      module.registerSection(section, `file-${index}.ts`);
      return section;
    });

    expect(TestResizeObserver.instances).toHaveLength(1);
    expect(TestIntersectionObserver.instances).toHaveLength(1);
    expect(addListener.mock.calls.filter(([event]) => event === 'scroll')).toHaveLength(1);

    TestIntersectionObserver.instances[0]!.emit(
      sections.map((target) => ({ target, isIntersecting: true }))
    );
    expect(module.nearPaths.size).toBe(MAX_RESIDENT_REVIEW_SECTIONS);
    expect(Array.from(module.nearPaths)).toEqual(
      Array.from({ length: MAX_RESIDENT_REVIEW_SECTIONS }, (_, index) => `file-${index}.ts`)
    );

    viewport.scrollTop = 320;
    viewport.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(module.scrollTop).toBe(320);
    expect(module.height).toBe(640);

    detach();
    expect(TestResizeObserver.instances[0]!.observed.size).toBe(0);
    expect(TestIntersectionObserver.instances[0]!.observed.size).toBe(0);
  });

  it('retains measured heights and preserves the anchor above the viewport', () => {
    const viewport = document.createElement('div');
    viewport.scrollTop = 500;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    const body = document.createElement('div');
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ top: -400 } as DOMRect);
    const module = new ReviewViewport();
    module.attach(viewport);
    module.registerBody(body, 'above.ts');
    const observer = TestResizeObserver.instances[0]!;

    observer.emit(body, 100);
    expect(module.retainedBodyHeight('above.ts', 48)).toBe(100);
    observer.emit(body, 140);

    expect(module.retainedBodyHeight('above.ts', 48)).toBe(140);
    expect(viewport.scrollTop).toBe(540);
  });

  it('scrolls a registered file section back to its header', () => {
    const viewport = document.createElement('div');
    viewport.scrollTop = 900;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      viewport.scrollTop = (options as ScrollToOptions).top ?? viewport.scrollTop;
    });
    Object.defineProperty(viewport, 'scrollTo', {
      configurable: true,
      value: scrollTo
    });
    const section = document.createElement('section');
    vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({ top: -250 } as DOMRect);
    const module = new ReviewViewport();
    module.attach(viewport);
    module.registerSection(section, 'deep-file.ts');

    expect(module.scrollSectionToTop('deep-file.ts')).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 550, behavior: 'auto' });
    expect(module.scrollTop).toBe(550);
  });
});

describe('estimateReviewBodyHeight', () => {
  it('creates a stable non-zero placeholder from the logical row count', () => {
    const diff = {
      path: 'large.ts',
      fromPath: null,
      kind: 'modified',
      binary: false,
      empty: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 3,
          newStart: 1,
          newCount: 3,
          header: '',
          lines: Array.from({ length: 3 }, () => ({
            kind: 'context',
            text: 'line',
            oldLine: 1,
            newLine: 1
          }))
        }
      ]
    } as FileDiff;

    expect(estimateReviewBodyHeight(diff, 12, false)).toBe(74);
    expect(estimateReviewBodyHeight(diff, 12, true)).toBe(80);
    expect(estimateReviewBodyHeight(null, 12, true)).toBe(48);
  });
});
