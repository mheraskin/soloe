import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultiDeviceSessionState } from '@shared/types/multi-device-sessions.js';

const mocks = vi.hoisted(() => ({
  stateChange: null as null | ((state: MultiDeviceSessionState) => void),
  deviceEvent: null as null | ((event: unknown) => void),
  deviceState: vi.fn(),
  refreshDevices: vi.fn(),
  startOnDevice: vi.fn(),
  deviceTerminalStop: vi.fn(),
  updateOnDevice: vi.fn(),
  deleteOnDevice: vi.fn()
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    sessions: {
      devicesSupported: true,
      deviceState: mocks.deviceState,
      refreshDevices: mocks.refreshDevices,
      startOnDevice: mocks.startOnDevice,
      deviceTerminalStop: mocks.deviceTerminalStop,
      updateOnDevice: mocks.updateOnDevice,
      deleteOnDevice: mocks.deleteOnDevice,
      onDeviceStateChange: vi.fn((listener) => {
        mocks.stateChange = listener;
        return () => undefined;
      }),
      onDeviceEvent: vi.fn((listener) => {
        mocks.deviceEvent = listener;
        return () => undefined;
      }),
      setDeviceTerminalDemand: vi.fn(async () => undefined)
    }
  }
}));

vi.mock('./sessions.svelte', () => ({
  sessions: {
    selected: null,
    selectedId: null,
    select: vi.fn()
  }
}));

import { DeviceSessionsStore } from './device-sessions.svelte';

describe('DeviceSessionsStore reconnect recovery', () => {
  beforeEach(() => {
    mocks.stateChange = null;
    mocks.deviceEvent = null;
    mocks.deviceState.mockReset().mockResolvedValue(state(1, true));
    mocks.refreshDevices.mockReset().mockResolvedValue(state(1, true));
    mocks.startOnDevice.mockReset().mockResolvedValue(state(2, true).unassigned[0]);
    mocks.deviceTerminalStop.mockReset().mockResolvedValue(true);
    mocks.updateOnDevice.mockReset().mockResolvedValue(state(2, true).unassigned[0]);
    mocks.deleteOnDevice.mockReset().mockResolvedValue({ ...state(2, true), unassigned: [] });
  });

  it('preserves the selected Session and announces a Device reconnect', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    store.selectSession('device-xps/session-1');
    const reconnected = vi.fn();
    store.onDeviceReconnect('device-xps', reconnected);

    mocks.stateChange?.(state(2, false));
    expect(store.selectedSessionKey).toBe('device-xps/session-1');
    expect(reconnected).not.toHaveBeenCalled();

    mocks.stateChange?.(state(3, true));
    expect(store.selectedSessionKey).toBe('device-xps/session-1');
    expect(reconnected).toHaveBeenCalledOnce();
  });

  it('projects Exit immediately but lets the next Device inventory remain authoritative', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    store.selectSession('device-xps/session-1');

    mocks.deviceEvent?.({
      event: 'exit',
      deviceId: 'device-xps',
      serverEpoch: 'epoch-xps',
      sequence: 2,
      observedAt: '2026-08-16T00:00:02.000Z',
      payload: {
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        exitCode: 0,
        signal: null
      }
    });
    expect(store.selectedProjection?.runtime).toBeNull();
    expect(store.selectedProjection?.lifecycleStatus).toBe('exited');

    mocks.stateChange?.(state(2, true, null));
    expect(store.selectedProjection?.runtime).toBeNull();
    expect(store.selectedProjection?.lifecycleStatus).toBe('stopped');
  });

  it('projects live observer snapshots for remote Session status', async () => {
    const store = new DeviceSessionsStore();
    await store.load();

    mocks.deviceEvent?.({
      event: 'observer.snapshot',
      deviceId: 'device-xps',
      serverEpoch: 'epoch-xps',
      sequence: 2,
      observedAt: '2026-08-16T00:00:02.000Z',
      payload: {
        id: 'session-1',
        sessionId: 'session-1',
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'codex',
        state: 'idle',
        lastEventAt: '2026-08-16T00:00:02.000Z'
      }
    });

    expect(store.selectedProjection).toBeNull();
    expect(store.sessions[0]?.observation).toMatchObject({
      sessionId: 'session-1',
      state: 'idle'
    });

    mocks.stateChange?.(state(2, true));
    expect(store.sessions[0]?.observation).toBeNull();
  });

  it('merges terminal status events with the existing runtime projection', async () => {
    const store = new DeviceSessionsStore();
    await store.load();

    mocks.deviceEvent?.({
      event: 'status',
      deviceId: 'device-xps',
      serverEpoch: 'epoch-xps',
      sequence: 2,
      observedAt: '2026-08-16T00:00:02.000Z',
      payload: {
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        status: 'running'
      }
    });

    expect(store.sessions[0]?.runtime).toMatchObject({
      status: 'running',
      cwd: '/home/me/project',
      startedAt: '2026-08-16T00:00:01.000Z'
    });
  });

  it('separates remote navigation from explicit resume', async () => {
    mocks.deviceState.mockResolvedValueOnce(state(1, true, null));
    mocks.refreshDevices.mockResolvedValueOnce(state(2, true, null));
    const store = new DeviceSessionsStore();
    await store.load();
    await vi.waitFor(() => expect(mocks.refreshDevices).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.refreshing).toBe(false));
    mocks.refreshDevices.mockResolvedValue(state(3, true));

    store.selectSession('device-xps/session-1');
    expect(store.selectedSessionKey).toBe('device-xps/session-1');
    expect(mocks.startOnDevice).not.toHaveBeenCalled();

    store.clearSelectedSession();
    await store.openSession('device-xps/session-1');
    expect(mocks.startOnDevice).toHaveBeenCalledOnce();
    expect(store.selectedSessionKey).toBe('device-xps/session-1');
  });

  it('optimistically starts a connected existing Session and rolls back on failure', async () => {
    mocks.deviceState.mockResolvedValueOnce(state(1, true, null));
    mocks.refreshDevices.mockResolvedValueOnce(state(1, true, null));
    const request = deferred<MultiDeviceSessionState['unassigned'][number]>();
    mocks.startOnDevice.mockReturnValueOnce(request.promise);
    const store = new DeviceSessionsStore();
    await store.load();

    const start = store.openSession('device-xps/session-1');
    expect(store.selectedProjection?.lifecycleStatus).toBe('stopped');
    expect(store.selectedProjection?.runtime).toBeNull();
    expect(store.pendingOperation('device-xps/session-1')).toBe('starting');

    request.reject(new Error('device disconnected'));
    await expect(start).rejects.toThrow('device disconnected');
    expect(store.selectedProjection).toBeNull();
    expect(store.sessions[0]?.lifecycleStatus).toBe('stopped');
    expect(store.pendingOperation('device-xps/session-1')).toBeNull();
  });

  it('does not undo newer navigation when a pending start fails', async () => {
    mocks.deviceState.mockResolvedValueOnce(state(1, true, null));
    mocks.refreshDevices.mockResolvedValueOnce(state(1, true, null));
    const request = deferred<MultiDeviceSessionState['unassigned'][number]>();
    mocks.startOnDevice.mockReturnValueOnce(request.promise);
    const store = new DeviceSessionsStore();
    await store.load();

    const start = store.openSession('device-xps/session-1');
    store.selectedSessionKey = 'newer-navigation';
    request.reject(new Error('device disconnected'));

    await expect(start).rejects.toThrow('device disconnected');
    expect(store.selectedSessionKey).toBe('newer-navigation');
  });

  it('shows pending stop intent without replacing Device-authoritative attachment state', async () => {
    const request = deferred<true>();
    mocks.deviceTerminalStop.mockReturnValueOnce(request.promise);
    const store = new DeviceSessionsStore();
    await store.load();

    const stop = store.stopSession('device-xps/session-1');
    expect(store.sessions[0]?.runtime?.terminalId).toBe('terminal-1');
    expect(store.sessions[0]?.lifecycleStatus).toBe('running');
    expect(store.pendingOperation('device-xps/session-1')).toBe('stopping');

    request.reject(new Error('stop rejected'));
    await expect(stop).rejects.toThrow('stop rejected');
    expect(store.sessions[0]?.runtime?.terminalId).toBe('terminal-1');
    expect(store.sessions[0]?.lifecycleStatus).toBe('running');
  });

  it('queues a fresh authoritative inventory after any refresh already in flight at stop time', async () => {
    const staleRefresh = deferred<MultiDeviceSessionState>();
    mocks.refreshDevices
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce(state(3, true, null));
    const store = new DeviceSessionsStore();
    await store.load();

    const stop = store.stopSession('device-xps/session-1');
    expect(mocks.refreshDevices).toHaveBeenCalledTimes(1);
    staleRefresh.resolve(state(2, true));
    await stop;

    expect(mocks.refreshDevices).toHaveBeenCalledTimes(2);
    expect(store.sessions[0]?.runtime).toBeNull();
    expect(store.sessions[0]?.lifecycleStatus).toBe('stopped');
  });

  it('optimistically updates name and color and rolls back rejected fields', async () => {
    const request = deferred<MultiDeviceSessionState['unassigned'][number]>();
    mocks.updateOnDevice.mockReturnValueOnce(request.promise);
    const store = new DeviceSessionsStore();
    await store.load();

    const update = store.updateSession('device-xps/session-1', {
      name: 'Renamed immediately',
      color: 'violet'
    });
    expect(store.sessions[0]?.session).toMatchObject({
      name: 'Renamed immediately',
      color: 'violet'
    });
    expect(store.pendingOperation('device-xps/session-1')).toBe('updating');

    request.reject(new Error('update rejected'));
    await expect(update).rejects.toThrow('update rejected');
    expect(store.sessions[0]?.session.name).toBe('Remote Codex');
    expect(store.sessions[0]?.session.color).toBeUndefined();
  });

  it('serializes overlapping optimistic updates against one confirmed base', async () => {
    const first = deferred<MultiDeviceSessionState['unassigned'][number]>();
    const second = deferred<MultiDeviceSessionState['unassigned'][number]>();
    mocks.updateOnDevice
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = new DeviceSessionsStore();
    await store.load();

    const renameA = store.updateSession('device-xps/session-1', { name: 'Name A' });
    const renameB = store.updateSession('device-xps/session-1', { name: 'Name B' });
    expect(store.sessions[0]?.session.name).toBe('Name B');
    expect(mocks.updateOnDevice).toHaveBeenCalledTimes(1);

    first.reject(new Error('A rejected'));
    await expect(renameA).rejects.toThrow('A rejected');
    expect(store.sessions[0]?.session.name).toBe('Name B');
    await vi.waitFor(() => expect(mocks.updateOnDevice).toHaveBeenCalledTimes(2));

    second.reject(new Error('B rejected'));
    await expect(renameB).rejects.toThrow('B rejected');
    expect(store.sessions[0]?.session.name).toBe('Remote Codex');
  });

  it('optimistically removes a Session and restores selection when deletion fails', async () => {
    const request = deferred<MultiDeviceSessionState>();
    mocks.deleteOnDevice.mockReturnValueOnce(request.promise);
    const store = new DeviceSessionsStore();
    await store.load();
    store.selectSession('device-xps/session-1');

    const deletion = store.deleteSession('device-xps/session-1');
    expect(store.sessions).toHaveLength(0);
    expect(store.selectedSessionKey).toBeNull();

    request.reject(new Error('delete rejected'));
    await expect(deletion).rejects.toThrow('delete rejected');
    expect(store.sessions).toHaveLength(1);
    expect(store.selectedSessionKey).toBe('device-xps/session-1');
  });
});

function state(
  revision: number,
  available: boolean,
  runtime: MultiDeviceSessionState['unassigned'][number]['runtime'] = {
    sessionId: 'session-1',
    terminalId: 'terminal-1',
    status: 'running',
    cwd: '/home/me/project',
    startedAt: '2026-08-16T00:00:01.000Z'
  }
): MultiDeviceSessionState {
  return {
    revision,
    capturedAt: `2026-08-16T00:00:0${revision}.000Z`,
    devices: [{
      deviceId: 'device-xps',
      name: 'xps',
      state: available ? 'ready' : 'offline',
      available,
      local: false,
      platform: 'linux'
    }],
    projects: [],
    unassigned: [{
      ref: { deviceId: 'device-xps', sessionId: 'session-1' },
      key: 'device-xps/session-1',
      deviceName: 'xps',
      available,
      session: {
        id: 'session-1',
        name: 'Remote Codex',
        cwd: '/home/me/project',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
        createdAt: '2026-08-16T00:00:00.000Z',
        lastUsedAt: '2026-08-16T00:00:00.000Z'
      },
      lifecycleStatus: runtime?.status ?? 'stopped',
      runtime,
      observation: null
    }],
    archivedSessions: []
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
