import type { DevToolsBounds } from '@shared/types/browser.js';

export interface BrowserDevToolsLayout {
  bounds?: DevToolsBounds;
  visible?: boolean;
}

export interface BrowserDevToolsBoundsAdapter {
  publish(webContentsId: number, layout: BrowserDevToolsLayout): Promise<void>;
}

export interface BrowserDevToolsEnvironment {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  observe(host: HTMLElement, invalidate: () => void): () => void;
  afterLayout(): Promise<void>;
}

/**
 * Keeps one native Browser DevTools View aligned to its renderer placeholder.
 *
 * Layout invalidations are coalesced into at most one measurement frame,
 * unchanged bounds are suppressed, and suspend/resume owns the offscreen
 * pointer-safety protocol used during native-view resize operations.
 */
export class BrowserDevToolsBoundsSync {
  private webContentsId: number | null = null;
  private host: HTMLElement | null = null;
  private lastPublished: DevToolsBounds | null = null;
  private frame: number | null = null;
  private stopObserving: (() => void) | null = null;
  private suspended = false;
  private publicationRevision = 0;
  private publicationInFlight = false;
  private pendingLayout: BrowserDevToolsLayout | null = null;
  private lastAttemptedBounds: DevToolsBounds | null = null;
  private retryBudget = 0;

  constructor(
    private readonly adapter: BrowserDevToolsBoundsAdapter,
    private readonly environment: BrowserDevToolsEnvironment = browserDevToolsEnvironment
  ) {}

  activate(
    webContentsId: number,
    host: HTMLElement,
    initialBounds: DevToolsBounds
  ): void {
    this.deactivate();
    this.webContentsId = webContentsId;
    this.host = host;
    this.lastPublished = initialBounds;
    this.lastAttemptedBounds = initialBounds;
    this.stopObserving = this.environment.observe(host, () => this.invalidate());
    // The main-process open request may take long enough for layout to move.
    // One coalesced verification closes that race without permanent polling.
    this.invalidate();
  }

  invalidate(): void {
    if (this.webContentsId === null || !this.host || this.suspended || this.frame !== null) return;
    this.frame = this.environment.requestFrame(() => {
      this.frame = null;
      this.measureAndPublish();
    });
  }

  suspend(): void {
    if (this.webContentsId === null || this.suspended) return;
    this.suspended = true;
    this.cancelPendingFrame();
    this.pendingLayout = { visible: false };
    this.flushPublication();
  }

  resume(): void {
    if (this.webContentsId === null || !this.suspended) return;
    this.suspended = false;
    this.lastPublished = null;
    this.invalidate();
  }

  deactivate(): void {
    this.cancelPendingFrame();
    this.stopObserving?.();
    this.stopObserving = null;
    this.webContentsId = null;
    this.host = null;
    this.lastPublished = null;
    this.suspended = false;
    this.publicationRevision += 1;
    this.pendingLayout = null;
    this.lastAttemptedBounds = null;
    this.retryBudget = 0;
  }

  private measureAndPublish(): void {
    const webContentsId = this.webContentsId;
    const host = this.host;
    if (webContentsId === null || !host || this.suspended) return;
    const bounds = measureDevToolsBounds(host);
    if (!bounds || sameBounds(bounds, this.lastPublished)) return;
    if (!sameBounds(bounds, this.lastAttemptedBounds)) {
      this.lastAttemptedBounds = bounds;
      this.retryBudget = 1;
    }
    this.pendingLayout = { bounds, ...(this.lastPublished === null ? { visible: true } : {}) };
    this.flushPublication();
  }

  private flushPublication(): void {
    if (this.publicationInFlight || !this.pendingLayout || this.webContentsId === null) return;
    if (
      this.pendingLayout.visible === undefined &&
      this.pendingLayout.bounds &&
      sameBounds(this.pendingLayout.bounds, this.lastPublished)
    ) {
      this.pendingLayout = null;
      return;
    }
    const layout = this.pendingLayout;
    const webContentsId = this.webContentsId;
    const revision = this.publicationRevision;
    this.pendingLayout = null;
    this.publicationInFlight = true;
    void this.adapter.publish(webContentsId, layout).then(
      () => {
        if (revision !== this.publicationRevision || webContentsId !== this.webContentsId) return;
        if (layout.bounds) {
          this.lastPublished = layout.bounds;
          this.retryBudget = 0;
        }
      },
      () => {
        // Keep lastPublished unchanged. A later invalidation retries the
        // current geometry instead of suppressing it as already applied.
        if (
          revision === this.publicationRevision &&
          layout.bounds &&
          sameBounds(layout.bounds, this.lastAttemptedBounds) &&
          this.retryBudget > 0
        ) {
          this.retryBudget -= 1;
          this.invalidate();
        }
      }
    ).finally(() => {
      this.publicationInFlight = false;
      this.flushPublication();
    });
  }

  private cancelPendingFrame(): void {
    if (this.frame === null) return;
    this.environment.cancelFrame(this.frame);
    this.frame = null;
  }
}

export interface BrowserDevToolsViewAdapter {
  open(webContentsId: number, bounds: DevToolsBounds): Promise<void>;
  setLayout(webContentsId: number, layout: BrowserDevToolsLayout): Promise<void>;
  close(webContentsId: number): Promise<void>;
}

/** Owns exact target and async lifecycle ordering for one Browser DevTools View. */
export class BrowserDevToolsViewController {
  private readonly bounds: BrowserDevToolsBoundsSync;
  private activeTargetId: number | null = null;
  private opening: Promise<boolean> | null = null;
  private closing: Promise<void> | null = null;
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly adapter: BrowserDevToolsViewAdapter,
    private readonly environment: BrowserDevToolsEnvironment = browserDevToolsEnvironment
  ) {
    this.bounds = new BrowserDevToolsBoundsSync(
      { publish: (webContentsId, layout) => adapter.setLayout(webContentsId, layout) },
      environment
    );
  }

  open(webContentsId: number, host: () => HTMLElement | null): Promise<boolean> {
    if (this.disposed || this.opening || this.activeTargetId !== null) {
      return Promise.resolve(false);
    }
    const revision = ++this.revision;
    const opening = this.performOpen(webContentsId, host, revision).finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    this.opening = opening;
    return opening;
  }

  async close(): Promise<void> {
    this.revision += 1;
    this.bounds.deactivate();
    const targetId = this.activeTargetId;
    this.activeTargetId = null;
    if (targetId === null) {
      if (this.closing) await this.closing;
      return;
    }
    const closing = this.adapter.close(targetId).finally(() => {
      if (this.closing === closing) this.closing = null;
    });
    this.closing = closing;
    await closing;
  }

  suspend(): void {
    this.bounds.suspend();
  }

  resume(): void {
    this.bounds.resume();
  }

  invalidate(): void {
    this.bounds.invalidate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pendingOpen = this.opening;
    await this.close();
    if (pendingOpen) await pendingOpen.catch(() => false);
  }

  private async performOpen(
    webContentsId: number,
    host: () => HTMLElement | null,
    revision: number
  ): Promise<boolean> {
    if (this.closing) await this.closing;
    await this.environment.afterLayout();
    if (!this.isCurrent(revision)) return false;
    const element = host();
    if (!element) return false;
    const initialBounds = measureDevToolsBounds(element);
    if (!initialBounds) return false;
    await this.adapter.open(webContentsId, initialBounds);
    if (!this.isCurrent(revision)) {
      await this.adapter.close(webContentsId);
      return false;
    }
    this.activeTargetId = webContentsId;
    this.bounds.activate(webContentsId, element, initialBounds);
    return true;
  }

  private isCurrent(revision: number): boolean {
    return !this.disposed && revision === this.revision;
  }
}

export function measureDevToolsBounds(element: HTMLElement): DevToolsBounds | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function sameBounds(a: DevToolsBounds, b: DevToolsBounds | null): boolean {
  return !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

const browserDevToolsEnvironment: BrowserDevToolsEnvironment = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  observe: (host, invalidate) => {
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(invalidate);
    observer?.observe(host);
    window.addEventListener('resize', invalidate);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', invalidate);
    };
  },
  afterLayout: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
};
