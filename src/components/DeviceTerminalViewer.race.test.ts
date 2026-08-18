/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminalMocks = vi.hoisted(() => ({
  writes: [] as string[],
  opens: 0,
  releaseCatchUpWrite: null as null | (() => void),
  releaseLiveWrite: null as null | (() => void),
  outputListener: null as null | ((event: { seq: number; data: string }) => void),
  reconnectListener: null as null | (() => void),
  screenSnapshot: vi.fn(),
  replay: vi.fn(),
  focus: vi.fn(),
  fit: vi.fn(),
  ownsInput: vi.fn(() => false),
  claimInput: vi.fn(async () => false),
  resize: vi.fn(async () => undefined),
  keyHandler: null as null | ((event: KeyboardEvent) => boolean),
  pasteImages: vi.fn()
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 30;
    private textarea: HTMLTextAreaElement | null = null;
    loadAddon() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      terminalMocks.keyHandler = handler;
    }
    open(host: HTMLElement) {
      terminalMocks.opens += 1;
      this.textarea = document.createElement('textarea');
      host.append(this.textarea);
    }
    resize() {}
    onData() { return { dispose() {} }; }
    paste() {}
    scrollToBottom() {}
    focus() {
      terminalMocks.focus();
      this.textarea?.focus();
    }
    dispose() {}
  }
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() { terminalMocks.fit(); } }
}));

vi.mock('../lib/terminal-write', () => ({
  FULL_TERMINAL_SCROLLBACK: 10_000,
  writeTerminalData: vi.fn(async (_terminal: unknown, data: string) => {
    terminalMocks.writes.push(data);
    if (data === 'catch-up') {
      await new Promise<void>((resolve) => {
        terminalMocks.releaseCatchUpWrite = resolve;
      });
    }
    if (data === 'live-2') {
      await new Promise<void>((resolve) => {
        terminalMocks.releaseLiveWrite = resolve;
      });
    }
  })
}));

vi.mock('../lib/terminal-transcript', () => ({
  TerminalTranscriptFollowController: class {
    shouldFollowNewOutput() { return false; }
    observe() {}
  },
  TerminalTranscriptProjector: class {
    async write() {}
    records() { return []; }
    resize() {}
    dispose() {}
  }
}));

vi.mock('../stores/device-sessions.svelte', () => ({
  deviceSessions: {
    terminalInputLeaseEvent: vi.fn(() => null),
    ownsTerminalInput: terminalMocks.ownsInput,
    claimTerminalInputControl: terminalMocks.claimInput,
    releaseTerminalInputControl: vi.fn(async () => true),
    onDeviceReconnect: vi.fn((_deviceId, listener) => {
      terminalMocks.reconnectListener = listener;
      return () => {
        if (terminalMocks.reconnectListener === listener) {
          terminalMocks.reconnectListener = null;
        }
      };
    }),
    acquireTerminalOutput: vi.fn((_ref, listener) => {
      terminalMocks.outputListener = listener;
      return { ready: Promise.resolve(), dispose: vi.fn() };
    }),
    terminalReplay: terminalMocks.replay,
    terminalScreenSnapshot: terminalMocks.screenSnapshot,
    terminalResize: terminalMocks.resize,
    terminalInput: vi.fn(async () => undefined),
    pasteImagesIntoTerminal: terminalMocks.pasteImages,
    updateSession: vi.fn(async () => undefined),
    previewCommand: vi.fn(async () => ({ description: '' }))
  }
}));

import DeviceTerminalViewer from './DeviceTerminalViewer.svelte';

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

describe('DeviceTerminalViewer output sequencing', () => {
  let component: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    terminalMocks.writes.length = 0;
    terminalMocks.opens = 0;
    terminalMocks.releaseCatchUpWrite = null;
    terminalMocks.releaseLiveWrite = null;
    terminalMocks.outputListener = null;
    terminalMocks.reconnectListener = null;
    terminalMocks.focus.mockReset();
    terminalMocks.fit.mockReset();
    terminalMocks.ownsInput.mockReset().mockReturnValue(false);
    terminalMocks.claimInput.mockReset().mockResolvedValue(false);
    terminalMocks.resize.mockReset().mockResolvedValue(undefined);
    terminalMocks.keyHandler = null;
    terminalMocks.pasteImages.mockReset().mockResolvedValue({
      paths: [],
      insertedText: '\x16'
    });
    terminalMocks.screenSnapshot.mockReset().mockRejectedValue(new Error('unavailable'));
    terminalMocks.replay.mockReset()
      .mockResolvedValueOnce({
        snapshot: { fromSeq: 1, toSeq: 1, data: 'screen', truncated: false }
      })
      .mockResolvedValueOnce({
        snapshot: { fromSeq: 2, toSeq: 3, data: 'live-2live-3', truncated: false }
      });
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('does not replay an in-flight live chunk when the next sequence arrives', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewer, {
      target,
      props: {
        projection: {
          ref: { deviceId: 'device-xps', sessionId: 'session-1' },
          key: 'device-xps/session-1',
          deviceName: 'xps',
          available: true,
          session: {
            id: 'session-1',
            name: 'Remote Codex',
            cwd: '/home/me/project',
            runMode: 'linux',
            launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
            createdAt: '2026-08-16T00:00:00.000Z',
            lastUsedAt: '2026-08-16T00:00:00.000Z'
          },
          runtime: {
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            status: 'running'
          }
        },
        onClose: vi.fn()
      }
    });
    flushSync();
    await vi.waitFor(() => expect(terminalMocks.writes).toEqual(['screen']));

    terminalMocks.outputListener?.({ seq: 2, data: 'live-2' });
    await vi.waitFor(() => expect(terminalMocks.releaseLiveWrite).not.toBeNull());

    terminalMocks.outputListener?.({ seq: 3, data: 'live-3' });
    await Promise.resolve();
    terminalMocks.releaseLiveWrite?.();
    await vi.waitFor(() => {
      expect(terminalMocks.writes).toEqual(['screen', 'live-2', 'live-3']);
    });
    expect(terminalMocks.replay).toHaveBeenCalledTimes(1);
  });

  it('replays output missed while the remote device reconnects', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewer, {
      target,
      props: {
        projection: remoteProjection(),
        onClose: vi.fn()
      }
    });
    flushSync();
    await vi.waitFor(() => expect(terminalMocks.writes).toEqual(['screen']));

    terminalMocks.reconnectListener?.();

    await vi.waitFor(() => {
      expect(terminalMocks.replay).toHaveBeenNthCalledWith(2, {
        deviceId: 'device-xps',
        terminalId: 'terminal-1'
      }, 1);
      expect(terminalMocks.writes).toEqual(['screen', 'live-2live-3']);
    });
  });

  it('restores remote scrollback before replaying output that arrived after the snapshot', async () => {
    terminalMocks.screenSnapshot.mockReset().mockResolvedValue({
      snapshot: {
        kind: 'xterm-vt-state-v1',
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        cols: 120,
        rows: 30,
        toSeq: 5,
        data: 'earlier conversation\r\ncurrent screen'
      }
    });
    terminalMocks.replay.mockReset().mockResolvedValue({
      snapshot: { fromSeq: 6, toSeq: 6, data: 'finished turn', truncated: false }
    });
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewer, {
      target,
      props: { projection: remoteProjection(), onClose: vi.fn() }
    });
    flushSync();

    await vi.waitFor(() => {
      expect(terminalMocks.writes).toEqual([
        'earlier conversation\r\ncurrent screen',
        'finished turn'
      ]);
    });
    expect(terminalMocks.replay).toHaveBeenCalledWith(
      { deviceId: 'device-xps', terminalId: 'terminal-1' },
      5
    );
  });

  it('keeps xterm detached until the initial catch-up replay has been parsed', async () => {
    terminalMocks.screenSnapshot.mockReset().mockResolvedValue({
      snapshot: {
        kind: 'xterm-vt-state-v1',
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        cols: 120,
        rows: 30,
        toSeq: 5,
        data: 'current screen'
      }
    });
    terminalMocks.replay.mockReset().mockResolvedValue({
      snapshot: { fromSeq: 6, toSeq: 6, data: 'catch-up', truncated: false }
    });
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewer, {
      target,
      props: { projection: remoteProjection(), onClose: vi.fn() }
    });
    flushSync();

    await vi.waitFor(() => expect(terminalMocks.releaseCatchUpWrite).not.toBeNull());
    expect(terminalMocks.opens).toBe(0);

    terminalMocks.releaseCatchUpWrite?.();
    await vi.waitFor(() => expect(terminalMocks.opens).toBe(1));
  });

  it('keeps a fresh agent startup replay covered until its output settles', async () => {
    vi.useFakeTimers();
    terminalMocks.ownsInput.mockReturnValue(true);
    terminalMocks.claimInput.mockResolvedValue(true);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
      toJSON: () => ({})
    });
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewer, {
      target,
      props: {
        projection: remoteProjection('codex', new Date().toISOString()),
        onClose: vi.fn()
      }
    });
    flushSync();
    await flushPromises();
    flushSync();

    expect(terminalMocks.opens).toBe(1);
    expect(target.textContent).toContain('Restoring terminal…');

    terminalMocks.outputListener?.({ seq: 2, data: 'resumed history' });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(750);
    flushSync();
    expect(target.textContent).toContain('Restoring terminal…');

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    flushSync();
    expect(target.textContent).not.toContain('Restoring terminal…');
  });

  it('restores terminal focus when the app regains focus', async () => {
    terminalMocks.ownsInput.mockReturnValue(true);
    terminalMocks.claimInput.mockResolvedValue(true);
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewer, {
      target,
      props: { projection: remoteProjection(), onClose: vi.fn() }
    });
    flushSync();
    await vi.waitFor(() => expect(target.querySelector('textarea')).not.toBeNull());
    target.querySelector('textarea')?.focus();
    terminalMocks.focus.mockClear();

    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(terminalMocks.focus).toHaveBeenCalledTimes(1));
  });

  it('refits a controlled remote terminal after mobile viewport recovery without forcing focus', async () => {
    terminalMocks.ownsInput.mockReturnValue(true);
    terminalMocks.claimInput.mockResolvedValue(true);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width') || query.includes('pointer: coarse'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 390,
      bottom: 700,
      width: 390,
      height: 700,
      toJSON: () => ({})
    });
    const target = document.createElement('div');
    document.body.append(target);
    component = mount(DeviceTerminalViewer, {
      target,
      props: { projection: remoteProjection(), onClose: vi.fn() }
    });
    flushSync();
    await vi.waitFor(() => expect(terminalMocks.claimInput).toHaveBeenCalled());
    await vi.waitFor(() => expect(terminalMocks.fit).toHaveBeenCalled());
    terminalMocks.fit.mockClear();
    terminalMocks.focus.mockClear();

    window.dispatchEvent(new CustomEvent('soloe:rail-layout', {
      detail: { keyboardOpen: false, keyboardClosed: true }
    }));

    await vi.waitFor(() => expect(terminalMocks.fit).toHaveBeenCalled());
    expect(terminalMocks.focus).not.toHaveBeenCalled();
  });

  it.each(['claude_code', 'codex'] as const)(
    'uploads pasted images to a remote %s session',
    async (provider) => {
      terminalMocks.ownsInput.mockReturnValue(true);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          read: vi.fn(async () => [{
            types: ['image/png'],
            getType: vi.fn(async () => new Blob([
              new Uint8Array([1, 2, 3])
            ], { type: 'image/png' }))
          }]),
          readText: vi.fn(async () => '')
        }
      });
      const target = document.createElement('div');
      document.body.append(target);
      component = mount(DeviceTerminalViewer, {
        target,
        props: { projection: remoteProjection(provider), onClose: vi.fn() }
      });
      flushSync();
      await vi.waitFor(() => expect(terminalMocks.keyHandler).not.toBeNull());

      const event = new KeyboardEvent('keydown', {
        cancelable: true,
        ctrlKey: true,
        key: 'v'
      });
      const preventDefault = vi.spyOn(event, 'preventDefault');
      expect(terminalMocks.keyHandler?.(event)).toBe(false);

      await vi.waitFor(() => expect(terminalMocks.pasteImages).toHaveBeenCalledWith(
        { deviceId: 'device-xps', terminalId: 'terminal-1' },
        'session-1',
        [{ mimeType: 'image/png', dataBase64: 'AQID' }]
      ));
      expect(preventDefault).toHaveBeenCalled();
    }
  );
});

async function flushPromises(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function remoteProjection(
  provider: 'claude_code' | 'codex' = 'codex',
  startedAt?: string
) {
  return {
    ref: { deviceId: 'device-xps', sessionId: 'session-1' },
    key: 'device-xps/session-1',
    deviceName: 'xps',
    available: true,
    session: {
      id: 'session-1',
      name: 'Remote Codex',
      cwd: '/home/me/project',
      runMode: 'linux' as const,
      launch: { type: 'agent' as const, provider, resumeMode: 'new' as const },
      createdAt: '2026-08-16T00:00:00.000Z',
      lastUsedAt: '2026-08-16T00:00:00.000Z'
    },
    runtime: {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
      status: 'running' as const,
      ...(startedAt ? { startedAt } : {})
    }
  };
}
