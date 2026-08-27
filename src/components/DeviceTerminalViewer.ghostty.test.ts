/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  surfaceCreates: 0,
  surfaceDisposes: 0,
  outputSubscriptions: 0,
  historyRequests: 0,
  reconnect: null as null | (() => void),
  localDeviceId: null as string | null,
  deviceAvailable: true,
  ownsInput: false,
  surfaceOptions: null as null | {
    predictiveInput?: boolean;
    font?: { family: string; size: number };
    onData(data: string, priority: 'text' | 'immediate' | 'protocol'): void;
    onInputBoundary?(): void;
    onLinkActivate?(text: string, event: MouseEvent): void;
  },
  terminalInput: vi.fn(async () => undefined),
  claimTerminalInputControl: vi.fn(async () => false),
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
    terminalInputLeaseEvent: vi.fn(() => null),
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
          truncated: false,
          byteLength: 15
        }
      };
    }),
    onDeviceReconnect: vi.fn((_deviceId, listener) => {
      mocks.reconnect = listener;
      return () => { mocks.reconnect = null; };
    }),
    terminalResize: vi.fn(async () => undefined),
    terminalInput: mocks.terminalInput,
    pasteImagesIntoTerminal: vi.fn(async () => undefined),
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
    mocks.reconnect = null;
    mocks.localDeviceId = null;
    mocks.deviceAvailable = true;
    mocks.ownsInput = false;
    mocks.surfaceOptions = null;
    mocks.terminalInput.mockClear();
    mocks.claimTerminalInputControl.mockClear();
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

  it('keeps a cached offline terminal visible and blocks all input', async () => {
    mocks.ownsInput = true;
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

    expect(target.textContent).toContain('Offline · read-only');
    expect(target.textContent).not.toContain('Restoring terminal…');
    expect(mocks.surfaceCreates).toBe(1);
    expect(mocks.surfaceDisposes).toBe(0);
    mocks.surfaceOptions?.onData('x', 'immediate');
    mocks.surfaceOptions?.onLinkActivate?.('https://example.com', new MouseEvent('click'));
    expect(mocks.terminalInput).not.toHaveBeenCalled();
    expect(mocks.claimTerminalInputControl).not.toHaveBeenCalled();
    expect(mocks.openDeviceBrowserUrl).not.toHaveBeenCalled();
    expect(target.textContent).not.toContain('Take Over');
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
