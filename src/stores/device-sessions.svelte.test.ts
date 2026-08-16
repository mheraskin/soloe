import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultiDeviceSessionState } from '@shared/types/multi-device-sessions.js';

const mocks = vi.hoisted(() => ({
  stateChange: null as null | ((state: MultiDeviceSessionState) => void),
  deviceEvent: null as null | ((event: unknown) => void),
  deviceState: vi.fn(),
  refreshDevices: vi.fn()
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    sessions: {
      devicesSupported: true,
      deviceState: mocks.deviceState,
      refreshDevices: mocks.refreshDevices,
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
});

function state(revision: number, available: boolean): MultiDeviceSessionState {
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
      runtime: {
        sessionId: 'session-1',
        terminalId: 'terminal-1',
        status: 'running'
      }
    }],
    archivedSessions: []
  };
}
