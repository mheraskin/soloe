import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  class FakeEmitter {
    listeners = new Map<string, Set<() => void>>();

    once(event: string, listener: () => void) {
      const wrapped = () => {
        this.removeListener(event, wrapped);
        listener();
      };
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(wrapped);
      this.listeners.set(event, listeners);
    }

    removeListener(event: string, listener: () => void) {
      this.listeners.get(event)?.delete(listener);
    }

    emit(event: string) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
    }
  }

  const handlers = new Map<string, (...args: any[]) => unknown>();
  const targets = new Map<number, any>();
  const views: any[] = [];
  let currentWindow: any = null;
  let rendererZoomFactor = 1;

  class FakeView {
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
    webContents = {
      isDestroyed: vi.fn(() => false),
      close: vi.fn()
    };

    constructor() {
      views.push(this);
    }
  }

  const createTarget = (id: number) => {
    const emitter = new FakeEmitter();
    let devToolsOpen = false;
    const target = Object.assign(emitter, {
      id,
      isDestroyed: vi.fn(() => false),
      setDevToolsWebContents: vi.fn(),
      openDevTools: vi.fn(() => { devToolsOpen = true; }),
      closeDevTools: vi.fn(() => { devToolsOpen = false; }),
      isDevToolsOpened: vi.fn(() => devToolsOpen)
    });
    targets.set(id, target);
    return target;
  };

  const createWindow = () => {
    const emitter = new FakeEmitter();
    return Object.assign(emitter, {
      isDestroyed: vi.fn(() => false),
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn()
      }
    });
  };

  return {
    handlers,
    targets,
    views,
    FakeView,
    createTarget,
    createWindow,
    setCurrentWindow: (window: any) => { currentWindow = window; },
    getCurrentWindow: () => currentWindow,
    setRendererZoomFactor: (factor: number) => { rendererZoomFactor = factor; },
    rendererSender: () => ({ getZoomFactor: () => rendererZoomFactor }),
    removeHandler: vi.fn()
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: electronMocks.removeHandler
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => electronMocks.getCurrentWindow())
  },
  WebContentsView: electronMocks.FakeView,
  webContents: {
    fromId: vi.fn((id: number) => electronMocks.targets.get(id) ?? null)
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import { BrowserIpc } from './browser.ipc.js';

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.targets.clear();
  electronMocks.views.length = 0;
  electronMocks.setRendererZoomFactor(1);
  electronMocks.removeHandler.mockClear();
});

describe('BrowserIpc DevTools ownership', () => {
  it('allows only one DevTools host per window and cleans it up on close', async () => {
    const window = electronMocks.createWindow();
    electronMocks.setCurrentWindow(window);
    const first = electronMocks.createTarget(1);
    const second = electronMocks.createTarget(2);
    const ipc = new BrowserIpc();
    ipc.register();

    await invokeOpen(1);
    expect(electronMocks.views).toHaveLength(1);
    expect(window.contentView.addChildView).toHaveBeenCalledTimes(1);

    await invokeOpen(2);
    expect(electronMocks.views).toHaveLength(2);
    expect(first.closeDevTools).toHaveBeenCalledTimes(1);
    expect(electronMocks.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(window.contentView.removeChildView).toHaveBeenCalledTimes(1);

    window.emit('closed');
    expect(second.closeDevTools).toHaveBeenCalledTimes(1);
    expect(electronMocks.views[1].webContents.close).toHaveBeenCalledTimes(1);
    ipc.dispose();
  });

  it('hides natively and restores bounds before making the view visible', async () => {
    const window = electronMocks.createWindow();
    electronMocks.setCurrentWindow(window);
    electronMocks.createTarget(1);
    const ipc = new BrowserIpc();
    ipc.register();
    await invokeOpen(1);
    const view = electronMocks.views[0];

    await invokeLayout({ webContentsId: 1, visible: false });
    expect(view.setVisible).toHaveBeenCalledWith(false);

    await invokeLayout({
      webContentsId: 1,
      bounds: { x: 10.4, y: 20.6, width: 799.8, height: 300.2 },
      visible: true
    });
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 21, width: 800, height: 300 });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.setBounds.mock.invocationCallOrder.at(-1)).toBeLessThan(
      view.setVisible.mock.invocationCallOrder.at(-1)
    );
    ipc.dispose();
  });

  it('converts zoomed renderer CSS bounds to native view bounds', async () => {
    const window = electronMocks.createWindow();
    electronMocks.setCurrentWindow(window);
    electronMocks.setRendererZoomFactor(1.5);
    electronMocks.createTarget(1);
    const ipc = new BrowserIpc();
    ipc.register();

    await invokeOpen(1, { x: 10, y: 20, width: 800, height: 300 });
    const view = electronMocks.views[0];
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 15,
      y: 30,
      width: 1200,
      height: 450
    });

    await invokeLayout({
      webContentsId: 1,
      bounds: { x: 12, y: 18, width: 720, height: 260 }
    });
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 18,
      y: 27,
      width: 1080,
      height: 390
    });
    ipc.dispose();
  });
});

async function invokeOpen(
  webContentsId: number,
  bounds = { x: 0, y: 0, width: 800, height: 300 }
): Promise<void> {
  const handler = electronMocks.handlers.get(IpcChannels.browser.openDevTools);
  if (!handler) throw new Error('openDevTools handler not registered');
  const result = await handler(
    { sender: electronMocks.rendererSender() },
    { webContentsId, bounds }
  );
  expect(result).toEqual({ ok: true, value: true });
}

async function invokeLayout(request: {
  webContentsId: number;
  bounds?: { x: number; y: number; width: number; height: number };
  visible?: boolean;
}): Promise<void> {
  const handler = electronMocks.handlers.get(IpcChannels.browser.setDevToolsLayout);
  if (!handler) throw new Error('setDevToolsLayout handler not registered');
  const result = await handler({ sender: electronMocks.rendererSender() }, request);
  expect(result).toEqual({ ok: true, value: true });
}
