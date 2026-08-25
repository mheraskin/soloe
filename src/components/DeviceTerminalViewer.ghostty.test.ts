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
  claimTerminalInputControl: vi.fn(async () => false)
}));

vi.mock('../lib/ghostty/surface', () => ({
  GhosttyTerminalSurface: {
    create: vi.fn(async () => {
      mocks.surfaceCreates += 1;
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
    terminalInputLeaseEvent: vi.fn(() => null),
    ownsTerminalInput: vi.fn(() => false),
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
    terminalInput: vi.fn(async () => undefined),
    pasteImagesIntoTerminal: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => undefined),
    previewCommand: vi.fn(async () => ({ description: '' }))
  }
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
    mocks.claimTerminalInputControl.mockClear();
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
});
