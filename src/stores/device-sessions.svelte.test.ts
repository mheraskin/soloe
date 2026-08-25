/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultiDeviceSessionState } from '@shared/types/multi-device-sessions.js';

const mocks = vi.hoisted(() => ({
  stateChange: null as null | ((state: MultiDeviceSessionState) => void),
  deviceEvent: null as null | ((event: unknown) => void),
  reconnect: null as null | (() => void),
  deviceState: vi.fn(),
  refreshDevices: vi.fn(),
  startOnDevice: vi.fn(),
  createOnDevice: vi.fn(),
  executeCreateOnDevice: vi.fn(),
  deviceTerminalStop: vi.fn(),
  deviceTerminalInputLease: vi.fn(),
  deviceTerminalInput: vi.fn(),
  deviceTerminalPasteImages: vi.fn(),
  deviceTerminalReleaseInputLease: vi.fn(),
  deviceTerminalParkInputLease: vi.fn(),
  setDeviceTerminalDemand: vi.fn(),
  updateOnDevice: vi.fn(),
  deleteOnDevice: vi.fn(),
  reorderOnDevices: vi.fn()
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    connection: {
      onReconnect: vi.fn((listener) => {
        mocks.reconnect = listener;
        return () => undefined;
      })
    },
    sessions: {
      devicesSupported: true,
      deviceState: mocks.deviceState,
      refreshDevices: mocks.refreshDevices,
      startOnDevice: mocks.startOnDevice,
      createOnDevice: mocks.createOnDevice,
      executeCreateOnDevice: mocks.executeCreateOnDevice,
      deviceTerminalStop: mocks.deviceTerminalStop,
      deviceTerminalInputLease: mocks.deviceTerminalInputLease,
      deviceTerminalInput: mocks.deviceTerminalInput,
      deviceTerminalPasteImages: mocks.deviceTerminalPasteImages,
      deviceTerminalReleaseInputLease: mocks.deviceTerminalReleaseInputLease,
      deviceTerminalParkInputLease: mocks.deviceTerminalParkInputLease,
      updateOnDevice: mocks.updateOnDevice,
      deleteOnDevice: mocks.deleteOnDevice,
      reorderOnDevices: mocks.reorderOnDevices,
      onDeviceStateChange: vi.fn((listener) => {
        mocks.stateChange = listener;
        return () => undefined;
      }),
      onDeviceEvent: vi.fn((listener) => {
        mocks.deviceEvent = listener;
        return () => undefined;
      }),
      setDeviceTerminalDemand: mocks.setDeviceTerminalDemand
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
    mocks.reconnect = null;
    mocks.deviceState.mockReset().mockResolvedValue(state(1, true));
    mocks.refreshDevices.mockReset().mockResolvedValue(state(1, true));
    mocks.startOnDevice.mockReset().mockResolvedValue(state(2, true).unassigned[0]);
    mocks.createOnDevice.mockReset();
    mocks.executeCreateOnDevice.mockReset();
    mocks.deviceTerminalStop.mockReset().mockResolvedValue(true);
    mocks.deviceTerminalInputLease.mockReset();
    mocks.deviceTerminalInput.mockReset().mockResolvedValue(true);
    mocks.deviceTerminalPasteImages.mockReset().mockResolvedValue({
      paths: [],
      insertedText: '\x16'
    });
    mocks.deviceTerminalReleaseInputLease.mockReset().mockResolvedValue(true);
    mocks.deviceTerminalParkInputLease.mockReset().mockResolvedValue(true);
    mocks.setDeviceTerminalDemand.mockReset().mockResolvedValue(undefined);
    mocks.updateOnDevice.mockReset().mockResolvedValue(state(2, true).unassigned[0]);
    mocks.deleteOnDevice.mockReset().mockResolvedValue({ ...state(2, true), unassigned: [] });
    mocks.reorderOnDevices.mockReset();
  });

  it('keeps the legacy local-only surface until a remote Device exists', () => {
    const store = new DeviceSessionsStore();
    store.state = {
      revision: 1,
      capturedAt: '2026-08-22T00:00:00.000Z',
      devices: [{
        deviceId: 'device-local',
        name: 'this device',
        state: 'ready',
        available: true,
        local: true
      }],
      projects: [],
      unassigned: [],
      archivedSessions: []
    };

    expect(store.multiDeviceActive).toBe(false);
    expect(store.visibleDevices.map((device) => device.deviceId)).toEqual(['device-local']);

    store.state = {
      ...store.state,
      devices: [...store.state.devices, {
        deviceId: 'device-xps',
        name: 'xps',
        state: 'ready',
        available: true,
        local: false
      }]
    };

    expect(store.multiDeviceActive).toBe(true);
    expect(store.visibleDevices.map((device) => device.deviceId)).toEqual([
      'device-local',
      'device-xps'
    ]);
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

  it('refreshes remote state, demand, and listeners after the renderer reconnects', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    const reconnected = vi.fn();
    store.onDeviceReconnect('device-xps', reconnected);
    const output = store.acquireTerminalOutput(
      { deviceId: 'device-xps', terminalId: 'terminal-1' },
      vi.fn()
    );
    await output.ready;
    mocks.refreshDevices.mockClear();
    mocks.setDeviceTerminalDemand.mockClear();

    mocks.reconnect?.();

    await vi.waitFor(() => expect(mocks.refreshDevices).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocks.setDeviceTerminalDemand).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(reconnected).toHaveBeenCalledOnce());
    output.dispose();
  });

  it('reorders remote Sessions immediately and rolls back when persistence fails', async () => {
    const initial = state(1, true);
    const second = structuredClone(initial.unassigned[0]!);
    second.key = 'device-xps/session-2';
    second.ref.sessionId = 'session-2';
    second.session.id = 'session-2';
    second.session.name = 'Second';
    initial.unassigned.push(second);
    mocks.deviceState.mockResolvedValueOnce(initial);
    mocks.refreshDevices.mockResolvedValueOnce(initial);
    const persisted = deferred<MultiDeviceSessionState>();
    mocks.reorderOnDevices.mockReturnValueOnce(persisted.promise);
    const store = new DeviceSessionsStore();
    await store.load();
    const ordered = [store.sessions[1]!, store.sessions[0]!];

    const request = store.reorder(ordered);
    expect(store.sessions.map((session) => session.key)).toEqual([
      'device-xps/session-2',
      'device-xps/session-1'
    ]);

    const refreshed = structuredClone(initial);
    refreshed.revision = 2;
    mocks.stateChange?.(refreshed);
    expect(store.sessions.map((session) => session.key)).toEqual([
      'device-xps/session-2',
      'device-xps/session-1'
    ]);

    persisted.reject(new Error('remote Device rejected the order'));
    await expect(request).rejects.toThrow('remote Device rejected the order');
    expect(store.sessions.map((session) => session.key)).toEqual([
      'device-xps/session-1',
      'device-xps/session-2'
    ]);
  });

  it('navigates to cached Sessions and refreshes an offline Device immediately', async () => {
    mocks.deviceState.mockResolvedValueOnce(state(1, false));
    mocks.refreshDevices.mockResolvedValueOnce(state(1, false));
    const store = new DeviceSessionsStore();
    await store.load();
    await vi.waitFor(() => expect(store.refreshing).toBe(false));
    mocks.refreshDevices.mockClear().mockResolvedValueOnce(state(2, true));

    store.selectSession('device-xps/session-1');

    expect(store.selectedSessionKey).toBe('device-xps/session-1');
    expect(store.activeSession).toMatchObject({
      id: 'session-1',
      cwd: '/home/me/project',
      runMode: 'linux'
    });
    expect(store.activeWorktreeScope).toEqual({
      cwd: '/home/me/project',
      runMode: 'linux',
      deviceId: 'device-xps'
    });
    await vi.waitFor(() => expect(mocks.refreshDevices).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.selectedProjection?.available).toBe(true));
  });

  it('does not let an older refresh overwrite a newer reconnect event', async () => {
    const staleRefresh = deferred<MultiDeviceSessionState>();
    mocks.deviceState.mockResolvedValueOnce(state(1, false));
    mocks.refreshDevices.mockReturnValueOnce(staleRefresh.promise);
    const store = new DeviceSessionsStore();
    await store.load();
    await vi.waitFor(() => expect(mocks.refreshDevices).toHaveBeenCalledOnce());

    mocks.stateChange?.(state(3, true));
    expect(store.device('device-xps')?.available).toBe(true);

    staleRefresh.resolve(state(2, false));
    await vi.waitFor(() => expect(store.refreshing).toBe(false));

    expect(store.state.revision).toBe(3);
    expect(store.device('device-xps')?.available).toBe(true);
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
    expect(mocks.setDeviceTerminalDemand).not.toHaveBeenCalled();

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
    expect(() => structuredClone(mocks.startOnDevice.mock.calls[0]?.[0])).not.toThrow();
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

  it('keeps a remote Session visible and selected with a deleting state until deletion completes', async () => {
    const request = deferred<MultiDeviceSessionState>();
    mocks.deleteOnDevice.mockReturnValueOnce(request.promise);
    const store = new DeviceSessionsStore();
    await store.load();
    store.selectSession('device-xps/session-1');

    const deletion = store.deleteSession('device-xps/session-1');
    expect(store.sessions).toHaveLength(1);
    expect(store.selectedSessionKey).toBe('device-xps/session-1');
    expect(store.pendingOperation('device-xps/session-1')).toBe('deleting');
    expect(() => structuredClone(mocks.deleteOnDevice.mock.calls[0]?.[0])).not.toThrow();

    request.reject(new Error('delete rejected'));
    await expect(deletion).rejects.toThrow('delete rejected');
    expect(store.sessions).toHaveLength(1);
    expect(store.selectedSessionKey).toBe('device-xps/session-1');
    expect(store.pendingOperation('device-xps/session-1')).toBeNull();
  });

  it('selects a newly created remote Session even when the refresh snapshot is stale', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    await vi.waitFor(() => expect(store.refreshing).toBe(false));
    const created = {
      ...state(2, true).unassigned[0]!,
      ref: { deviceId: 'device-xps', sessionId: 'session-2' },
      key: 'device-xps/session-2',
      session: {
        ...state(2, true).unassigned[0]!.session,
        id: 'session-2',
        name: 'New remote Session'
      }
    };
    mocks.executeCreateOnDevice.mockResolvedValueOnce(created);
    mocks.refreshDevices.mockResolvedValueOnce(state(1, true));

    await store.executeCreate('plan-1');

    expect(store.selectedSessionKey).toBe('device-xps/session-2');
  });

  it('creates and continues a Session on the origin Device without using local input', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    await vi.waitFor(() => expect(store.refreshing).toBe(false));
    const created = {
      ...state(2, true).unassigned[0]!,
      ref: { deviceId: 'device-xps', sessionId: 'session-2' },
      key: 'device-xps/session-2',
      session: {
        ...state(2, true).unassigned[0]!.session,
        id: 'session-2',
        name: 'Cursor',
        launch: { type: 'agent' as const, provider: 'cursor' as const, resumeMode: 'new' as const }
      },
      runtime: {
        sessionId: 'session-2',
        terminalId: 'terminal-2',
        status: 'running' as const
      }
    };
    mocks.createOnDevice.mockResolvedValueOnce(created);
    mocks.refreshDevices.mockResolvedValueOnce({
      ...state(2, true),
      unassigned: [state(2, true).unassigned[0]!, created]
    });
    mocks.deviceTerminalInputLease.mockResolvedValueOnce({
      terminalId: 'terminal-2',
      sessionId: 'session-2',
      ownerDeviceId: 'device-xps',
      leaseId: 'lease-2',
      controllerDeviceId: 'device-local',
      controllerDeviceName: 'this device',
      generation: 1,
      cols: 120,
      rows: 30,
      acquiredAt: '2026-08-16T00:00:02.000Z'
    });

    await store.createBeside('device-xps/session-1', {
      name: 'Cursor',
      launch: { type: 'agent', provider: 'cursor', resumeMode: 'new' },
      continuationPrompt: 'Continue this task',
      continuationProvider: 'cursor'
    });

    expect(mocks.createOnDevice).toHaveBeenCalledWith({
      workspaceKey: null,
      targetDeviceId: 'device-xps',
      targetPath: '/home/me/project',
      session: {
        name: 'Cursor',
        launch: { type: 'agent', provider: 'cursor', resumeMode: 'new' }
      }
    });
    expect(mocks.deviceTerminalInput).toHaveBeenNthCalledWith(
      1,
      { deviceId: 'device-xps', terminalId: 'terminal-2' },
      '\x1b[200~Continue this task\x1b[201~',
      expect.objectContaining({ leaseId: 'lease-2' })
    );
    expect(mocks.deviceTerminalInput).toHaveBeenNthCalledWith(
      2,
      { deviceId: 'device-xps', terminalId: 'terminal-2' },
      '\r',
      expect.objectContaining({ leaseId: 'lease-2' })
    );
    expect(mocks.deviceTerminalParkInputLease).not.toHaveBeenCalled();
    expect(store.selectedSessionKey).toBe('device-xps/session-2');
  });

  it('uploads remote terminal images with the owned Session Control lease', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    const ref = { deviceId: 'device-xps', terminalId: 'terminal-1' };
    mocks.deviceTerminalInputLease.mockResolvedValueOnce({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      ownerDeviceId: 'device-xps',
      leaseId: 'lease-1',
      controllerDeviceId: 'device-local',
      controllerDeviceName: 'this device',
      generation: 1,
      cols: 120,
      rows: 30,
      acquiredAt: '2026-08-16T00:00:02.000Z'
    });
    await store.claimTerminalInputControl(ref);

    await store.pasteImagesIntoTerminal(
      ref,
      'session-1',
      [{ mimeType: 'image/png', dataBase64: 'cG5n' }]
    );

    expect(mocks.deviceTerminalPasteImages).toHaveBeenCalledWith(
      ref,
      'session-1',
      [{ mimeType: 'image/png', dataBase64: 'cG5n' }],
      expect.objectContaining({ leaseId: 'lease-1', ownerDeviceId: 'device-xps' })
    );
  });

  it('reclaims Session Control before uploading a remote clipboard image', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    const ref = { deviceId: 'device-xps', terminalId: 'terminal-1' };
    mocks.deviceTerminalInputLease.mockResolvedValueOnce({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      ownerDeviceId: 'device-xps',
      leaseId: 'lease-image',
      controllerDeviceId: 'device-local',
      controllerDeviceName: 'this device',
      generation: 2,
      cols: 120,
      rows: 30,
      acquiredAt: '2026-08-16T00:00:18.000Z'
    });

    await store.pasteImagesIntoTerminal(
      ref,
      'session-1',
      [{ mimeType: 'image/png', dataBase64: 'cG5n' }]
    );

    expect(mocks.deviceTerminalPasteImages).toHaveBeenCalledWith(
      ref,
      'session-1',
      [{ mimeType: 'image/png', dataBase64: 'cG5n' }],
      expect.objectContaining({ leaseId: 'lease-image' })
    );
  });

  it('reclaims stale Session Control and retries rejected terminal input once', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    const ref = { deviceId: 'device-xps', terminalId: 'terminal-1' };
    const firstLease = {
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      ownerDeviceId: 'device-xps',
      leaseId: 'lease-stale',
      controllerDeviceId: 'device-local',
      controllerDeviceName: 'this device',
      generation: 1,
      cols: 120,
      rows: 30,
      acquiredAt: '2026-08-16T00:00:02.000Z'
    };
    const renewedLease = {
      ...firstLease,
      leaseId: 'lease-current',
      generation: 2,
      acquiredAt: '2026-08-16T00:00:18.000Z'
    };
    mocks.deviceTerminalInputLease
      .mockResolvedValueOnce(firstLease)
      .mockResolvedValueOnce(renewedLease);
    const stale = Object.assign(new Error('stale Session Control'), {
      code: 'terminal_control_lease_stale'
    });
    mocks.deviceTerminalInput
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce(true);
    await store.claimTerminalInputControl(ref);

    await store.terminalInput(ref, 'a');

    expect(mocks.deviceTerminalInput).toHaveBeenNthCalledWith(
      1,
      ref,
      'a',
      expect.objectContaining({ leaseId: 'lease-stale' })
    );
    expect(mocks.deviceTerminalInput).toHaveBeenNthCalledWith(
      2,
      ref,
      'a',
      expect.objectContaining({ leaseId: 'lease-current' })
    );
  });

  it('batches terminal input that arrives while a remote write is in flight', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    const ref = { deviceId: 'device-xps', terminalId: 'terminal-1' };
    mocks.deviceTerminalInputLease.mockResolvedValueOnce({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      ownerDeviceId: 'device-xps',
      leaseId: 'lease-current',
      controllerDeviceId: 'device-local',
      controllerDeviceName: 'this device',
      generation: 1,
      cols: 120,
      rows: 30,
      acquiredAt: '2026-08-16T00:00:18.000Z'
    });
    const firstWrite = deferred<boolean>();
    mocks.deviceTerminalInput
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue(true);
    await store.claimTerminalInputControl(ref);

    const first = store.terminalInput(ref, 'a');
    await vi.waitFor(() => expect(mocks.deviceTerminalInput).toHaveBeenCalledTimes(1));
    const second = store.terminalInput(ref, 'b');
    const third = store.terminalInput(ref, 'c');
    const fourth = store.terminalInput(ref, 'd');
    firstWrite.resolve(true);
    await Promise.all([first, second, third, fourth]);

    expect(mocks.deviceTerminalInput).toHaveBeenCalledTimes(2);
    expect(mocks.deviceTerminalInput).toHaveBeenNthCalledWith(
      2,
      ref,
      'bcd',
      expect.objectContaining({ leaseId: 'lease-current' })
    );
  });

  it('reclaims an unowned Session Control lease before forwarding terminal input', async () => {
    const store = new DeviceSessionsStore();
    await store.load();
    const ref = { deviceId: 'device-xps', terminalId: 'terminal-1' };
    mocks.deviceTerminalInputLease.mockResolvedValueOnce({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      ownerDeviceId: 'device-xps',
      leaseId: 'lease-reclaimed',
      controllerDeviceId: 'device-local',
      controllerDeviceName: 'this device',
      generation: 2,
      cols: 120,
      rows: 30,
      acquiredAt: '2026-08-16T00:00:18.000Z'
    });

    await store.terminalInput(ref, 'm');

    expect(mocks.deviceTerminalInputLease).toHaveBeenCalledWith(ref, false);
    expect(mocks.deviceTerminalInput).toHaveBeenCalledWith(
      ref,
      'm',
      expect.objectContaining({ leaseId: 'lease-reclaimed' })
    );
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
