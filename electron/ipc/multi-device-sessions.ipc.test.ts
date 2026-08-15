import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  removeHandler: vi.fn()
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: electronMocks.removeHandler
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import { MultiDeviceSessionsIpc } from './multi-device-sessions.ipc.js';

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
});

describe('MultiDeviceSessionsIpc', () => {
  it('registers the Sessions handlers before any Device refresh is attempted', async () => {
    const state = {
      revision: 1,
      capturedAt: '2026-08-13T10:00:00.000Z',
      devices: [],
      projects: [],
      unassigned: [],
      archivedSessions: []
    };
    const sessions = {
      state: vi.fn(() => structuredClone(state)),
      refresh: vi.fn(async () => {
        throw new Error('Device is offline');
      }),
      reorderSessions: vi.fn(async () => structuredClone(state)),
      create: vi.fn(),
      planCreate: vi.fn(),
      executeCreate: vi.fn(),
      startSession: vi.fn(),
      terminalCurrentInputLease: vi.fn(async () => null),
      terminalReleaseInputLease: vi.fn(async () => true),
      onState: vi.fn(() => () => undefined),
      onDeviceEvent: vi.fn(() => () => undefined)
    };
    const ipc = new MultiDeviceSessionsIpc({
      sessions: sessions as never,
      getWindows: () => []
    });

    ipc.register();

    expect(electronMocks.handlers.has(IpcChannels.sessions.deviceState)).toBe(true);
    expect(electronMocks.handlers.has(IpcChannels.sessions.refreshDevices)).toBe(true);
    expect(electronMocks.handlers.has(IpcChannels.sessions.reorderOnDevices)).toBe(true);
    expect(electronMocks.handlers.has(IpcChannels.sessions.createOnDevice)).toBe(true);
    expect(electronMocks.handlers.has(IpcChannels.sessions.planCreateOnDevice)).toBe(true);
    expect(electronMocks.handlers.has(IpcChannels.sessions.executeCreateOnDevice)).toBe(true);
    expect(electronMocks.handlers.has(IpcChannels.sessions.startOnDevice)).toBe(true);
    expect(electronMocks.handlers.has(
      IpcChannels.sessions.deviceTerminalCurrentInputLease
    )).toBe(true);
    expect(electronMocks.handlers.has(
      IpcChannels.sessions.deviceTerminalReleaseInputLease
    )).toBe(true);
    await expect(invoke(IpcChannels.sessions.deviceState)).resolves.toEqual({
      ok: true,
      value: state
    });
    expect(sessions.refresh).not.toHaveBeenCalled();

    const orderedRefs = [
      { deviceId: 'device-1', sessionId: 'remote-session' },
      { deviceId: 'device-2', sessionId: 'local-session' }
    ];
    await expect(invoke(IpcChannels.sessions.reorderOnDevices, orderedRefs)).resolves.toEqual({
      ok: true,
      value: state
    });
    expect(sessions.reorderSessions).toHaveBeenCalledWith(orderedRefs);

    const ref = { deviceId: 'device-1', terminalId: 'terminal-1' };
    await expect(invoke(
      IpcChannels.sessions.deviceTerminalCurrentInputLease,
      ref
    )).resolves.toEqual({ ok: true, value: null });
    await expect(invoke(
      IpcChannels.sessions.deviceTerminalReleaseInputLease,
      { ref, leaseId: 'lease-1' }
    )).resolves.toEqual({ ok: true, value: true });
    expect(sessions.terminalCurrentInputLease).toHaveBeenCalledWith(ref);
    expect(sessions.terminalReleaseInputLease).toHaveBeenCalledWith(ref, 'lease-1');
  });

  it('publishes changed Device state to every live window', () => {
    const state = {
      revision: 2,
      capturedAt: '2026-08-13T10:00:01.000Z',
      devices: [],
      projects: [],
      unassigned: [],
      archivedSessions: []
    };
    let publish: ((value: typeof state) => void) | null = null;
    const send = vi.fn();
    const destroyedSend = vi.fn();
    const sessions = {
      state: vi.fn(() => structuredClone(state)),
      refresh: vi.fn(async () => structuredClone(state)),
      reorderSessions: vi.fn(async () => structuredClone(state)),
      create: vi.fn(),
      planCreate: vi.fn(),
      executeCreate: vi.fn(),
      startSession: vi.fn(),
      onState: vi.fn((listener: (value: typeof state) => void) => {
        publish = listener;
        return () => undefined;
      }),
      onDeviceEvent: vi.fn(() => () => undefined)
    };
    const ipc = new MultiDeviceSessionsIpc({
      sessions: sessions as never,
      getWindows: () => [
        { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
        { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: destroyedSend } }
      ] as never
    });
    ipc.register();

    publish!(state);

    expect(send).toHaveBeenCalledWith(IpcChannels.sessions.deviceStateChanged, state);
    expect(destroyedSend).not.toHaveBeenCalled();
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler({ sender: {} } as never, ...args as never[]);
}
