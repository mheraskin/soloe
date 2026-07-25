import type { FileDiff } from '@shared/types/git.js';

const DEFAULT_VIEWPORT_HEIGHT = 800;
export const MAX_RESIDENT_REVIEW_SECTIONS = 12;

type ScrollSubscriber = (scrollTop: number) => void;

interface ActionRegistration {
  update(path: string): void;
  destroy(): void;
}

/**
 * Owns the shared viewport resources for a multi-file review.
 *
 * File bodies stay deliberately unaware of native viewport events. This
 * module fans one coalesced snapshot out to the resident bodies and uses one
 * observer of each kind regardless of how many files are in the review.
 */
export class ReviewViewport {
  scrollTop = $state(0);
  height = $state(DEFAULT_VIEWPORT_HEIGHT);
  scrollVersion = $state(0);
  layoutVersion = $state(0);
  nearPaths = $state<ReadonlySet<string>>(new Set());
  bodyHeights = $state<Readonly<Record<string, number>>>({});

  private viewport: HTMLElement | null = null;
  private sections = new Map<string, HTMLElement>();
  private sectionPaths = new Map<Element, string>();
  private bodies = new Map<string, HTMLElement>();
  private bodyPaths = new Map<Element, string>();
  private intersectionObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionCandidates = new Set<string>();
  private scrollSubscribers = new Set<ScrollSubscriber>();
  private scrollFrame: number | null = null;

  attach(viewport: HTMLElement | null): () => void {
    this.detachViewport();
    if (!viewport) return () => {};

    this.viewport = viewport;
    this.syncViewport();
    viewport.addEventListener('scroll', this.onScroll, { passive: true });
    this.createObservers();

    return () => {
      if (this.viewport === viewport) this.detachViewport();
    };
  }

  subscribeScroll(subscriber: ScrollSubscriber): () => void {
    this.scrollSubscribers.add(subscriber);
    return () => this.scrollSubscribers.delete(subscriber);
  }

  registerSection(node: HTMLElement, path: string): ActionRegistration {
    this.sections.set(path, node);
    this.sectionPaths.set(node, path);
    this.intersectionObserver?.observe(node);
    if (!this.intersectionObserver) this.rebuildFallbackResidents();

    let current = path;
    return {
      update: (next: string) => {
        if (next === current) return;
        this.sections.delete(current);
        this.intersectionCandidates.delete(current);
        current = next;
        this.sections.set(current, node);
        this.sectionPaths.set(node, current);
        this.publishResidents();
      },
      destroy: () => {
        this.intersectionObserver?.unobserve(node);
        this.sections.delete(current);
        this.sectionPaths.delete(node);
        this.intersectionCandidates.delete(current);
        this.publishResidents();
      }
    };
  }

  registerBody(node: HTMLElement, path: string): ActionRegistration {
    this.bodies.set(path, node);
    this.bodyPaths.set(node, path);
    this.resizeObserver?.observe(node);

    let current = path;
    return {
      update: (next: string) => {
        if (next === current) return;
        this.bodies.delete(current);
        current = next;
        this.bodies.set(current, node);
        this.bodyPaths.set(node, current);
      },
      destroy: () => {
        this.resizeObserver?.unobserve(node);
        this.bodies.delete(current);
        this.bodyPaths.delete(node);
      }
    };
  }

  retainedBodyHeight(path: string, estimate: number): number {
    const measured = this.bodyHeights[path];
    return measured && measured > 0 ? measured : estimate;
  }

  scrollSectionToTop(path: string, behavior: ScrollBehavior = 'auto'): boolean {
    const viewport = this.viewport;
    const section = this.sections.get(path);
    if (!viewport || !section) return false;

    const top =
      viewport.scrollTop +
      section.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top;
    viewport.scrollTo({ top: Math.max(0, top), behavior });
    this.syncViewport();
    return true;
  }

  private readonly onScroll = (): void => {
    const top = this.viewport?.scrollTop ?? 0;
    for (const subscriber of this.scrollSubscribers) subscriber(top);
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestFrame(() => {
      this.scrollFrame = null;
      this.syncViewport();
      this.scrollVersion++;
    });
  };

  private syncViewport(): void {
    const viewport = this.viewport;
    if (!viewport) return;
    this.scrollTop = viewport.scrollTop;
    this.height = viewport.clientHeight || DEFAULT_VIEWPORT_HEIGHT;
  }

  private createObservers(): void {
    const viewport = this.viewport;
    if (!viewport) return;

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        let nextHeights: Record<string, number> | null = null;
        let viewportChanged = false;
        let anchorAdjustment = 0;
        for (const entry of entries) {
          if (entry.target === viewport) {
            viewportChanged = true;
            continue;
          }
          const path = this.bodyPaths.get(entry.target);
          const measured = entry.contentRect.height;
          const previous = path ? (this.bodyHeights[path] ?? 0) : 0;
          if (!path || measured <= 0 || Math.abs(previous - measured) < 0.5) {
            continue;
          }
          // overflow-anchor is disabled on the review root because row
          // virtualization owns layout. Preserve the visual anchor when a
          // fully off-screen body above it settles from estimate to measure.
          if (previous > 0) {
            const body = entry.target as HTMLElement;
            const bodyTop =
              body.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
            if (bodyTop + previous <= viewport.scrollTop) {
              anchorAdjustment += measured - previous;
            }
          }
          nextHeights ??= { ...this.bodyHeights };
          nextHeights[path] = measured;
        }
        if (viewportChanged) this.syncViewport();
        if (nextHeights) this.bodyHeights = nextHeights;
        if (anchorAdjustment !== 0) {
          viewport.scrollTop = Math.max(0, viewport.scrollTop + anchorAdjustment);
          this.syncViewport();
        }
        this.layoutVersion++;
      });
      this.resizeObserver.observe(viewport);
      for (const body of this.bodies.values()) this.resizeObserver.observe(body);
    }

    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const path = this.sectionPaths.get(entry.target);
            if (!path) continue;
            if (entry.isIntersecting) this.intersectionCandidates.add(path);
            else this.intersectionCandidates.delete(path);
          }
          this.publishResidents();
        },
        { root: viewport, rootMargin: '75% 0px 75% 0px' }
      );
      for (const section of this.sections.values()) this.intersectionObserver.observe(section);
    } else {
      this.rebuildFallbackResidents();
    }
  }

  private rebuildFallbackResidents(): void {
    this.intersectionCandidates = new Set(
      Array.from(this.sections.keys()).slice(0, MAX_RESIDENT_REVIEW_SECTIONS)
    );
    this.publishResidents();
  }

  private publishResidents(): void {
    const next = new Set<string>();
    for (const path of this.intersectionCandidates) {
      next.add(path);
      if (next.size >= MAX_RESIDENT_REVIEW_SECTIONS) break;
    }
    if (sameSet(next, this.nearPaths)) return;
    this.nearPaths = next;
  }

  private detachViewport(): void {
    const viewport = this.viewport;
    if (viewport) viewport.removeEventListener('scroll', this.onScroll);
    this.viewport = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionCandidates.clear();
    this.nearPaths = new Set();
    if (this.scrollFrame !== null) {
      cancelFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
  }
}

export function estimateReviewBodyHeight(
  diff: FileDiff | null,
  fontSize: number,
  wrap: boolean
): number {
  if (!diff || diff.binary || diff.empty || diff.hunks.length === 0) return 48;
  let rows = 0;
  for (const hunk of diff.hunks) rows += 1 + hunk.lines.length;
  rows += Math.max(0, diff.hunks.length - 1);
  const lineHeight = Math.max(18, fontSize * 1.55) * (wrap ? 1.08 : 1);
  return Math.max(48, Math.round(rows * lineHeight));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(callback);
  queueMicrotask(() => callback(0));
  return -1;
}

function cancelFrame(handle: number): void {
  if (handle < 0 || typeof cancelAnimationFrame === 'undefined') return;
  cancelAnimationFrame(handle);
}
