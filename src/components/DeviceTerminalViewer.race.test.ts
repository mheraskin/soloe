/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminalMocks = vi.hoisted(() => ({
  writes: [] as string[],
  releaseLiveWrite: null as null | (() => void),
  outputListener: null as null | ((event: { seq: number; data: string }) => void),
  reconnectListener: null as null | (() => void),
  replay: vi.fn()
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 30;
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    scrollToBottom() {}
    focus() {}
    dispose() {}
  }
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} }
}));

vi.mock('../lib/terminal-write', () => ({
  FULL_TERMINAL_SCROLLBACK: 10_000,
  writeTerminalData: vi.fn(async (_terminal: unknown, data: string) => {
    terminalMocks.writes.push(data);
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
    ownsTerminalInput: vi.fn(() => false),
    claimTerminalInputControl: vi.fn(async () => false),
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
    terminalResize: vi.fn(async () => undefined),
    terminalInput: vi.fn(async () => undefined),
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
    terminalMocks.releaseLiveWrite = null;
    terminalMocks.outputListener = null;
    terminalMocks.reconnectListener = null;
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
  });

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
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
});

function remoteProjection() {
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
      launch: { type: 'agent' as const, provider: 'codex' as const, resumeMode: 'new' as const },
      createdAt: '2026-08-16T00:00:00.000Z',
      lastUsedAt: '2026-08-16T00:00:00.000Z'
    },
    runtime: {
      sessionId: 'session-1',
      terminalId: 'terminal-1',
      status: 'running' as const
    }
  };
}
