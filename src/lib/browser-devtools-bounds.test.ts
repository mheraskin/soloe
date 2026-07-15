// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevToolsBounds } from '@shared/types/browser.js';
import {
  BrowserDevToolsBoundsSync,
  BrowserDevToolsViewController,
  type BrowserDevToolsLayout,
  type BrowserDevToolsViewAdapter
} from './browser-devtools-bounds';

describe('BrowserDevToolsBoundsSync', () => {
  let host: HTMLElement;
  let rect: DevToolsBounds;
  let environment: TestEnvironment;
  let publish: ReturnType<typeof createPublisher>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    rect = { x: 10, y: 20, width: 800, height: 300 };
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height
    }) as DOMRect);
    environment = new TestEnvironment();
    publish = createPublisher();
  });

  it('coalesces invalidations and publishes only changed bounds', () => {
    const sync = new BrowserDevToolsBoundsSync({ publish }, environment);
    sync.activate(7, host, rect);
    sync.invalidate();
    sync.invalidate();

    expect(environment.pendingFrames()).toBe(1);
    environment.flushFrame();
    expect(publish).not.toHaveBeenCalled();

    rect = { ...rect, x: 30 };
    environment.invalidateLayout();
    environment.invalidateLayout();
    expect(environment.pendingFrames()).toBe(1);
    environment.flushFrame();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(7, { bounds: rect });
  });

  it('hides the native view while suspended and restores it once', async () => {
    const sync = new BrowserDevToolsBoundsSync({ publish }, environment);
    sync.activate(7, host, rect);
    environment.flushFrame();

    sync.suspend();
    sync.suspend();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(7, { visible: false });

    rect = { ...rect, height: 420 };
    environment.invalidateLayout();
    expect(environment.pendingFrames()).toBe(0);
    sync.resume();
    expect(environment.pendingFrames()).toBe(1);
    environment.flushFrame();
    await settle();
    expect(publish).toHaveBeenLastCalledWith(7, { bounds: rect, visible: true });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('disconnects observation and cancels pending work on deactivate', () => {
    const sync = new BrowserDevToolsBoundsSync({ publish }, environment);
    sync.activate(7, host, rect);
    expect(environment.pendingFrames()).toBe(1);

    sync.deactivate();
    expect(environment.pendingFrames()).toBe(0);
    expect(environment.observing).toBe(false);
    environment.invalidateLayout();
    environment.flushFrame();
    expect(publish).not.toHaveBeenCalled();
  });

  it('replaces prior target ownership without leaking its observer or frame', () => {
    const other = document.createElement('div');
    document.body.append(other);
    vi.spyOn(other, 'getBoundingClientRect').mockReturnValue({
      left: 1,
      top: 2,
      width: 3,
      height: 4
    } as DOMRect);
    const sync = new BrowserDevToolsBoundsSync({ publish }, environment);
    sync.activate(7, host, rect);
    sync.activate(9, other, { x: 1, y: 2, width: 3, height: 4 });

    expect(environment.stopCount).toBe(1);
    expect(environment.pendingFrames()).toBe(1);
    environment.flushFrame();
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps only the latest geometry while one publication is in flight', async () => {
    const first = deferred<void>();
    publish.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const sync = new BrowserDevToolsBoundsSync({ publish }, environment);
    sync.activate(7, host, rect);
    environment.flushFrame();

    rect = { ...rect, x: 20 };
    environment.invalidateLayout();
    environment.flushFrame();
    rect = { ...rect, x: 30 };
    environment.invalidateLayout();
    environment.flushFrame();
    rect = { ...rect, x: 40 };
    environment.invalidateLayout();
    environment.flushFrame();
    expect(publish).toHaveBeenCalledTimes(1);

    first.resolve();
    await settle();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(7, { bounds: rect });
  });

  it('automatically retries unchanged geometry once after a failed publication', async () => {
    publish.mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
    const sync = new BrowserDevToolsBoundsSync({ publish }, environment);
    sync.activate(7, host, rect);
    environment.flushFrame();

    rect = { ...rect, width: 700 };
    environment.invalidateLayout();
    environment.flushFrame();
    await settle();
    expect(publish).toHaveBeenCalledTimes(1);

    expect(environment.pendingFrames()).toBe(1);
    environment.flushFrame();
    await settle();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(7, { bounds: rect });
  });
});

describe('BrowserDevToolsViewController', () => {
  it('closes the captured target when close races a pending open', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 300
    } as DOMRect);
    const environment = new TestEnvironment();
    const opened = deferred<void>();
    const adapter = createViewAdapter();
    adapter.open.mockReturnValueOnce(opened.promise);
    const controller = new BrowserDevToolsViewController(adapter, environment);

    const result = controller.open(7, () => host);
    await settle();
    const closing = controller.close();
    opened.resolve(undefined);
    await expect(result).resolves.toBe(false);
    await closing;

    expect(adapter.open).toHaveBeenCalledWith(7, { x: 0, y: 0, width: 800, height: 300 });
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(adapter.close).toHaveBeenCalledWith(7);
  });

  it('uses the original target for layout and close after activation', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    let rect = { x: 0, y: 0, width: 800, height: 300 };
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height
    }) as DOMRect);
    const environment = new TestEnvironment();
    const adapter = createViewAdapter();
    const controller = new BrowserDevToolsViewController(adapter, environment);

    await expect(controller.open(7, () => host)).resolves.toBe(true);
    environment.flushFrame();
    rect = { ...rect, width: 700 };
    environment.invalidateLayout();
    environment.flushFrame();
    await settle();
    await controller.close();

    expect(adapter.setLayout).toHaveBeenCalledWith(7, { bounds: rect });
    expect(adapter.close).toHaveBeenCalledWith(7);
  });

  it('surfaces open failure and permits a later retry', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 300
    } as DOMRect);
    const environment = new TestEnvironment();
    const adapter = createViewAdapter();
    adapter.open.mockRejectedValueOnce(new Error('logical IPC failure'));
    const controller = new BrowserDevToolsViewController(adapter, environment);

    await expect(controller.open(7, () => host)).rejects.toThrow('logical IPC failure');
    await expect(controller.open(7, () => host)).resolves.toBe(true);
    expect(adapter.open).toHaveBeenCalledTimes(2);
  });
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createPublisher() {
  return vi.fn<(
    webContentsId: number,
    layout: BrowserDevToolsLayout
  ) => Promise<void>>(async () => undefined);
}

function createViewAdapter() {
  return {
    open: vi.fn<BrowserDevToolsViewAdapter['open']>(async () => undefined),
    setLayout: vi.fn<BrowserDevToolsViewAdapter['setLayout']>(async () => undefined),
    close: vi.fn<BrowserDevToolsViewAdapter['close']>(async () => undefined)
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestEnvironment {
  private nextFrame = 1;
  private frames = new Map<number, FrameRequestCallback>();
  private invalidate: (() => void) | null = null;
  observing = false;
  stopCount = 0;

  requestFrame = (callback: FrameRequestCallback): number => {
    const handle = this.nextFrame++;
    this.frames.set(handle, callback);
    return handle;
  };

  cancelFrame = (handle: number): void => {
    this.frames.delete(handle);
  };

  observe = (_host: HTMLElement, invalidate: () => void): (() => void) => {
    this.invalidate = invalidate;
    this.observing = true;
    return () => {
      this.invalidate = null;
      this.observing = false;
      this.stopCount += 1;
    };
  };

  afterLayout = async (): Promise<void> => undefined;

  invalidateLayout(): void {
    this.invalidate?.();
  }

  pendingFrames(): number {
    return this.frames.size;
  }

  flushFrame(): void {
    const entry = this.frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return;
    this.frames.delete(entry[0]);
    entry[1](0);
  }
}
