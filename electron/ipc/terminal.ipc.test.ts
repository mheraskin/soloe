import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TerminalExitEvent,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import { terminalControlProof, type TerminalInputLease } from '@shared/types/terminal.js';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  removeHandler: vi.fn()
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: electronMocks.removeHandler
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import type { PtyManager } from '../terminal/PtyManager.js';
import { TerminalIpc } from './terminal.ipc.js';

class FakeWebContents extends EventEmitter {
  send = vi.fn();
  isDestroyed = vi.fn(() => false);

  constructor(readonly id: number) {
    super();
  }
}

function createWindow(id: number) {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: new FakeWebContents(id)
  };
}

function createPty(): PtyManager {
  const pty = new EventEmitter();
  return Object.assign(pty, {
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    listRunning: vi.fn(() => []),
    replay: vi.fn(() => null)
  }) as unknown as PtyManager;
}

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
});

describe('TerminalIpc output demand', () => {
  it('publishes high-volume output only to the window demanding its terminal', async () => {
    const pty = createPty();
    const first = createWindow(1);
    const second = createWindow(2);
    const ipc = new TerminalIpc({
      pty,
      getWindows: () => [first, second] as never
    });
    ipc.register();

    pty.emit('output', output('t-1', 1, 'discarded-before-demand'));
    expect(first.webContents.send).not.toHaveBeenCalled();
    expect(second.webContents.send).not.toHaveBeenCalled();

    await demand(first.webContents, 't-1', true);
    pty.emit('output', output('t-1', 2, 'visible'));
    pty.emit('output', output('t-2', 1, 'other-terminal'));

    expect(first.webContents.send).toHaveBeenCalledOnce();
    expect(first.webContents.send).toHaveBeenCalledWith(
      IpcChannels.terminal.output,
      output('t-1', 2, 'visible')
    );
    expect(second.webContents.send).not.toHaveBeenCalled();
    ipc.dispose();
  });

  it('keeps lifecycle facts broadcast while output demand remains selective', async () => {
    const pty = createPty();
    const first = createWindow(1);
    const second = createWindow(2);
    const ipc = new TerminalIpc({
      pty,
      getWindows: () => [first, second] as never
    });
    ipc.register();
    await demand(first.webContents, 't-1', true);

    const status: TerminalStatusEvent = {
      sessionId: 's-1',
      terminalId: 't-1',
      status: 'running'
    };
    const location: TerminalLocationEvent = {
      sessionId: 's-1',
      terminalId: 't-1',
      cwd: '/repo'
    };
    const exit: TerminalExitEvent = {
      sessionId: 's-1',
      terminalId: 't-1',
      exitCode: 0,
      signal: null
    };
    pty.emit('status', status);
    pty.emit('location', location);
    pty.emit('exit', exit);

    for (const win of [first, second]) {
      expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.terminal.status, status);
      expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.terminal.location, location);
      expect(win.webContents.send).toHaveBeenCalledWith(IpcChannels.terminal.exit, exit);
    }

    first.webContents.send.mockClear();
    pty.emit('output', output('t-1', 3, 'after-exit'));
    expect(first.webContents.send).not.toHaveBeenCalled();
    ipc.dispose();
  });

  it('releases every terminal demand when its renderer is destroyed', async () => {
    const pty = createPty();
    const win = createWindow(1);
    const ipc = new TerminalIpc({
      pty,
      getWindows: () => [win] as never
    });
    ipc.register();
    await demand(win.webContents, 't-1', true);
    await demand(win.webContents, 't-2', true);

    win.webContents.emit('destroyed');
    pty.emit('output', output('t-1', 1, 'one'));
    pty.emit('output', output('t-2', 1, 'two'));

    expect(win.webContents.send).not.toHaveBeenCalled();
    ipc.dispose();
  });
});

describe('TerminalIpc control lease', () => {
  it('rejects spectator input and resize and releases control on renderer destruction', async () => {
    const pty = createPty();
    vi.mocked(pty.listRunning).mockReturnValue([{
      sessionId: 's-1',
      terminalId: 't-1',
      status: 'running',
      runtimeMode: 'tui',
      startedAt: '2026-08-15T08:00:00.000Z'
    }]);
    const controller = createWindow(1);
    const spectator = createWindow(2);
    const ipc = new TerminalIpc({
      pty,
      getWindows: () => [controller, spectator] as never
    });
    ipc.register();
    const acquire = electronMocks.handlers.get(IpcChannels.terminal.acquireInputLease)!;
    const input = electronMocks.handlers.get(IpcChannels.terminal.input)!;
    const resize = electronMocks.handlers.get(IpcChannels.terminal.resize)!;
    const current = electronMocks.handlers.get(IpcChannels.terminal.currentInputLease)!;

    const acquired = await acquire(
      { sender: controller.webContents },
      't-1',
      { deviceId: 'device-a', deviceName: 'MacBook Pro' },
      false
    ) as { ok: true; value: TerminalInputLease };
    expect(acquired.ok).toBe(true);

    const spectatorControl = {
      ...terminalControlProof(acquired.value),
      controllerDeviceId: 'device-b'
    };

    await expect(input({ sender: spectator.webContents }, {
      terminalId: 't-1',
      data: 'spectator',
      control: spectatorControl
    })).resolves.toMatchObject({ ok: false });
    await expect(resize({ sender: spectator.webContents }, {
      terminalId: 't-1',
      dimensions: { cols: 80, rows: 24 },
      control: spectatorControl
    })).resolves.toMatchObject({ ok: false });
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();

    controller.webContents.emit('destroyed');
    await expect(current({ sender: spectator.webContents }, 't-1')).resolves.toEqual({
      ok: true,
      value: null
    });
    ipc.dispose();
  });
});

async function demand(
  sender: FakeWebContents,
  terminalId: string,
  active: boolean
): Promise<void> {
  const handler = electronMocks.handlers.get(IpcChannels.terminal.outputDemand);
  if (!handler) throw new Error('output demand handler not registered');
  await expect(handler({ sender }, { terminalId, active })).resolves.toEqual({
    ok: true,
    value: true
  });
}

function output(terminalId: string, seq: number, data: string): TerminalOutputEvent {
  return { terminalId, sessionId: `session-${terminalId}`, seq, data };
}
