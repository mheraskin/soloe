import { describe, expect, it } from 'vitest';
import type { CockpitDeviceSummary } from '@shared/types/cockpit.js';
import type { MachineConnection } from '@shared/types/connections.js';
import {
  connectionDevices,
  connectionDevicePresentation,
  deviceFilterPresentation,
  devicePresentation,
  reconcileDeviceSummaries,
  sessionDevicePresentation
} from './device-presentation.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

describe('devicePresentation', () => {
  it('uses a green dot and only the Device name while it is available', () => {
    expect(devicePresentation(device('ready'))).toEqual({
      label: 'Studio Mac',
      actionable: true,
      tone: 'online',
      dot: true
    });
  });

  it.each([
    ['offline', 'Studio Mac · Offline', 'offline'],
    ['degraded', 'Studio Mac · Unavailable', 'offline'],
    ['provisional', 'Studio Mac · Unavailable', 'offline'],
    ['connecting', 'Studio Mac · Connecting', 'connecting'],
    ['incompatible', 'Studio Mac · Update Soloe', 'update']
  ] as const)('makes %s Devices non-actionable with plain-language status', (state, label, tone) => {
    expect(devicePresentation(device(state))).toEqual({
      label,
      actionable: false,
      tone,
      dot: false
    });
  });

  it('makes a cached Session unavailable when its owning Device is absent', () => {
    expect(sessionDevicePresentation(DEVICE_ID, [])).toEqual({
      label: 'Unknown Device · Offline',
      actionable: false,
      tone: 'offline',
      dot: false
    });
  });

  it('presents the current machine as online while the Cockpit snapshot is connecting', () => {
    expect(reconcileDeviceSummaries(
      [device('connecting')],
      [machine({ id: 'local', source: 'local', trust: 'local', isSelf: true })]
    )).toEqual([
      expect.objectContaining({
        deviceId: DEVICE_ID,
        name: 'Studio Mac',
        state: 'ready',
        isLocal: true
      })
    ]);
  });

  it('presents connection state as a distinct status instead of appending it to the name', () => {
    expect(connectionDevicePresentation(machine({
      id: `device:${DEVICE_ID}`,
      source: 'discovered',
      trust: 'pinned',
      isSelf: false,
      name: 'Build PC',
      updateRequired: true
    }))).toEqual({
      name: 'Build PC',
      status: 'Update Soloe',
      tone: 'update',
      isLocal: false
    });
  });

  it('never reports the running local application as needing its own update', () => {
    expect(connectionDevicePresentation(machine({ updateRequired: true }))).toEqual({
      name: 'Studio Mac',
      status: 'Online',
      tone: 'online',
      isLocal: true
    });
  });

  it('lists the current Device before discovered remote Devices', () => {
    const remote = machine({
      id: `device:${DEVICE_ID}`,
      name: 'Build PC',
      source: 'discovered',
      trust: 'pinned',
      isSelf: false
    });

    expect(connectionDevices([remote, machine()]).map(({ id }) => id)).toEqual([
      'local',
      `device:${DEVICE_ID}`
    ]);
  });

  it('represents an unfiltered single-Device cockpit as the current Device, not All Devices', () => {
    expect(deviceFilterPresentation(
      [{ ...device('ready'), isLocal: true }],
      []
    )).toEqual({
      showAggregate: false,
      selectedDeviceId: DEVICE_ID
    });
  });

  it('offers the aggregate view only when there are multiple Devices', () => {
    expect(deviceFilterPresentation(
      [
        { ...device('ready'), isLocal: true },
        {
          deviceId: '22222222-2222-4222-8222-222222222222',
          name: 'Build PC',
          state: 'ready',
          isLocal: false
        }
      ],
      []
    )).toEqual({
      showAggregate: true,
      selectedDeviceId: null
    });
  });

  function device(state: CockpitDeviceSummary['state']): CockpitDeviceSummary {
    return { deviceId: DEVICE_ID, name: 'Studio Mac', state };
  }

  function machine(
    overrides: Partial<MachineConnection> = {}
  ): MachineConnection {
    return {
      id: 'local',
      name: 'Studio Mac',
      endpoint: null,
      endpointAliases: [],
      source: 'local',
      status: 'available',
      trust: 'local',
      enabled: true,
      active: true,
      isSelf: true,
      deviceId: DEVICE_ID,
      ...overrides
    };
  }
});
