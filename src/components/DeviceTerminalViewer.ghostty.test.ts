/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalInputLeaseEvent } from '@shared/types/terminal.js';

const mocks = vi.hoisted(() => ({
  surfaceCreates: 0,
  surfaceDisposes: 0,
  outputSubscriptions: 0,
  historyRequests: 0,
  historyTruncated: false,
  reconnect: null as null | (() => void),
  localDeviceId: null as string | null,
  deviceAvailable: true,
  ownsInput: false,
  inputLeaseEvent: null as TerminalInputLeaseEvent | null,
  surfaceOptions: null as null | {
    predictiveInput?: boolean;
    font?: { family: string; size: number };
    onData(data: string, priority: 'text' | 'immediate' | 'protocol'): void;
    onInputBoundary?(): void;
    onLinkActivate?(text: string, event: MouseEvent): void;
    onPaste?(event: ClipboardEvent): boolean;
  },
  terminalInput: vi.fn(async () => undefined),
  terminalResize: vi.fn(async () => undefined),
  claimTerminalInputControl: vi.fn(async () => false),
  pasteImagesIntoTerminal: vi.fn(async () => undefined),
  openDeviceBrowserUrl: vi.fn(async () => undefined)
}));

vi.mock('../lib/ghostty/surface', () => ({
  GhosttyTerminalSurface: {
    create: vi.fn(async (_mount, options) => {
      mocks.surfaceCreates += 1;
      mocks.surfaceOptions = options;
      return {
        cols: 120,
        rows: 30,
        dispose: () => { mocks.surfaceDisposes += 1; },
        resetAndWrite: vi.fn(),
        resetAndReplay: vi.fn(),
        write: vi.fn(),
        captureViewportIntent: vi.fn(() => ({ kind: 'follow-output' })),
        restoreViewportIntent: vi.fn(),
        focus: vi.fn(),
        fit: vi.fn(() => true),
        setTheme: vi.fn(),
        setFont: vi.fn(async () => undefined),
        pasteFromClipboard: vi.fn(async () => undefined)
      };
    })
  }
}));

vi.mock('../stores/device-sessions.svelte', () => ({
  deviceSessions: {
    device: vi.fn(() => ({ available: mocks.deviceAvailable })),
    get localDevice() {
      return mocks.localDeviceId
        ? { deviceId: mocks.localDeviceId, name: 'local' }
        : null;
    },
    terminalInputLeaseEvent: vi.fn(() => mocks.inputLeaseEvent),
    ownsTerminalInput: vi.fn(() => mocks.ownsInput),
    claimTerminalInputControl: mocks.claimTerminalInputControl,
    acquireTerminalOutput: vi.fn(() => {
      mocks.outputSubscriptions += 1;
      return { ready: Promise.resolve(), dispose: vi.fn() };
    }),
    terminalHistory: vi.fn(async () => {
      mocks.historyRequests += 1;
      return {
        snapshot: {
          kind: 'ghostty-vt-history-v1',
          terminalId: 'terminal-1',
          sessionId: 'session-1',
          cols: 120,
          rows: 30,
          data: 'restored screen',
          fromSeq: 1,
          toSeq: 1,
          truncated: mocks.historyTruncated,
          byteLength: 15
        }
      };
    }),
    onDeviceReconnect: vi.fn((_deviceId, listener) => {
      mocks.reconnect = listener;
      return () => { mocks.reconnect = null; };
    }),
    terminalResize: mocks.terminalResize,
    terminalInput: mocks.terminalInput,
    pasteImagesIntoTerminal: mocks.pasteImagesIntoTerminal,
    updateSession: vi.fn(async () => undefined),
    previewCommand: vi.fn(async () => ({ description: '' }))
  }
}));

vi.mock('../stores/settings.svelte', () => ({
  settings: {
    current: {
      terminal: { fontSize: 14 }
    }
  }
}));

vi.mock('../lib/browser-device-navigation', () => ({
  openDeviceBrowserUrl: mocks.openDeviceBrowserUrl
}));

import DeviceTerminalViewerHarness from './__fixtures__/DeviceTerminalViewerHarness.svelte';

describe('DeviceTerminalViewer Ghostty lifecycle', () => {
  let component: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    mocks.surfaceCreates = 0;
    mocks.surfaceDisposes = 0;
    mocks.outputSubscriptions = 0;
    mocks.historyRequests = 0;
    mocks.historyTruncated = false;
    mocks.reconnect = null;
    mocks.localDeviceId = null;
    mocks.deviceAvailable = true;
    mocks.ownsInput = false;
    mocks.inputLeaseEvent = null;
    mocks.surfaceOptions = null;
    mocks.terminalInput.mockClear();
    mocks.terminalResize.mockClear();
    mocks.claimTerminalInputControl.mockClear();
    mocks.pasteImagesIntoTerminal.mockClear();
    mocks.openDeviceBrowserUrl.mockClear();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
  });

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('keeps a ready surface revealed when the same remote terminal projection refreshes', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();

    await vi.waitFor(() => {
      expect(target.textContent).not.toContain('Restoring terminal…');
    });
    expect(mocks.surfaceCreates).toBe(1);
    expect(mocks.outputSubscriptions).toBe(1);
    expect(mocks.historyRequests).toBe(1);

    const harness = component as typeof component & { refreshSameTerminal(): void };
    flushSync(() => harness.refreshSameTerminal());
    await Promise.resolve();
    flushSync();

    expect(target.textContent).not.toContain('Restoring terminal…');
    expect(mocks.surfaceCreates).toBe(1);
    expect(mocks.surfaceDisposes).toBe(0);
    expect(mocks.outputSubscriptions).toBe(1);
    expect(mocks.historyRequests).toBe(1);
  });

  it('reclaims input control when the renderer reconnects to a selected terminal', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.claimTerminalInputControl).toHaveBeenCalledOnce());

    mocks.reconnect?.();

    await vi.waitFor(() => expect(mocks.claimTerminalInputControl).toHaveBeenCalledTimes(2));
  });

  it('jiggles the PTY size to repaint a truncated Terminal Replay Tail', async () => {
    mocks.ownsInput = true;
    mocks.historyTruncated = true;
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();

    await vi.waitFor(() => {
      expect(mocks.terminalResize.mock.calls.slice(-2)).toEqual([
        [{ deviceId: 'device-xps', terminalId: 'terminal-1' }, 119, 30],
        [{ deviceId: 'device-xps', terminalId: 'terminal-1' }, 120, 30]
      ]);
    });
  });

  it('batches remote text while flushing controls and TUI scrolling immediately', async () => {
    mocks.ownsInput = true;
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.surfaceOptions).not.toBeNull());
    expect(mocks.surfaceOptions?.predictiveInput).toBe(true);

    mocks.surfaceOptions?.onData('h', 'text');
    mocks.surfaceOptions?.onData('i', 'text');
    expect(mocks.terminalInput).not.toHaveBeenCalled();

    mocks.surfaceOptions?.onData('\r', 'immediate');
    expect(mocks.terminalInput).toHaveBeenNthCalledWith(
      1,
      { deviceId: 'device-xps', terminalId: 'terminal-1' },
      'hi\r'
    );

    mocks.surfaceOptions?.onData('\u001b[B', 'immediate');
    expect(mocks.terminalInput).toHaveBeenNthCalledWith(
      2,
      { deviceId: 'device-xps', terminalId: 'terminal-1' },
      '\u001b[B'
    );
  });

  it('keeps same-device terminal input unbatched', async () => {
    mocks.localDeviceId = 'device-xps';
    mocks.ownsInput = true;
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.surfaceOptions).not.toBeNull());

    expect(mocks.surfaceOptions?.predictiveInput).toBe(false);
    mocks.surfaceOptions?.onData('a', 'text');
    expect(mocks.terminalInput).toHaveBeenCalledWith(
      { deviceId: 'device-xps', terminalId: 'terminal-1' },
      'a'
    );
  });

  it('pastes a native clipboard image without Async Clipboard permission', async () => {
    mocks.ownsInput = true;
    const clipboardRead = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read: clipboardRead }
    });
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.surfaceOptions).not.toBeNull());
    const image = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', {
      type: 'image/png'
    });
    const event = {
      clipboardData: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => image
          }
        ],
        files: []
      }
    } as unknown as ClipboardEvent;

    expect(mocks.surfaceOptions?.onPaste?.(event)).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.pasteImagesIntoTerminal).toHaveBeenCalledWith(
        { deviceId: 'device-xps', terminalId: 'terminal-1' },
        'session-1',
        [{ mimeType: 'image/png', dataBase64: 'AQID' }]
      );
    });
    expect(clipboardRead).not.toHaveBeenCalled();
  });

  it('keeps a cached offline terminal writable and queues input for reconnect', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.surfaceOptions).not.toBeNull());
    await vi.waitFor(() => expect(target.textContent).not.toContain('Restoring terminal…'));
    mocks.terminalInput.mockClear();
    mocks.claimTerminalInputControl.mockClear();

    const harness = component as typeof component & { setAvailable(available: boolean): void };
    flushSync(() => harness.setAvailable(false));

    expect(target.textContent).toContain('Offline · input queued until reconnect');
    expect(target.textContent).not.toContain('Restoring terminal…');
    expect(mocks.surfaceCreates).toBe(1);
    expect(mocks.surfaceDisposes).toBe(0);
    mocks.surfaceOptions?.onData('x', 'immediate');
    mocks.surfaceOptions?.onLinkActivate?.('https://example.com', new MouseEvent('click'));
    expect(mocks.terminalInput).toHaveBeenCalledWith(
      { deviceId: 'device-xps', terminalId: 'terminal-1' },
      'x'
    );
    expect(mocks.claimTerminalInputControl).not.toHaveBeenCalled();
    expect(mocks.openDeviceBrowserUrl).not.toHaveBeenCalled();
    expect(target.textContent).not.toContain('Take Over');
  });

  it('keeps an offline terminal read-only when another client owns control', async () => {
    mocks.inputLeaseEvent = {
      type: 'acquired',
      terminalId: 'terminal-1',
      lease: {
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        ownerDeviceId: 'device-xps',
        leaseId: 'lease-other',
        controllerDeviceId: 'device-other',
        controllerDeviceName: 'other laptop',
        generation: 1,
        cols: 120,
        rows: 30,
        acquiredAt: '2026-08-16T00:00:18.000Z'
      },
      observedAt: '2026-08-16T00:00:18.000Z'
    };
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.surfaceOptions).not.toBeNull());
    mocks.terminalInput.mockClear();

    const harness = component as typeof component & { setAvailable(available: boolean): void };
    flushSync(() => harness.setAvailable(false));
    mocks.surfaceOptions?.onData('x', 'immediate');

    expect(target.textContent).toContain('Offline · controlled by other laptop');
    expect(mocks.terminalInput).not.toHaveBeenCalled();
  });

  it('uses the controlling Device terminal font size for a remote surface', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewerHarness, { target });
    flushSync();
    await vi.waitFor(() => expect(mocks.surfaceOptions).not.toBeNull());

    expect(mocks.surfaceOptions?.font).toEqual(expect.objectContaining({ size: 14 }));
  });
});
