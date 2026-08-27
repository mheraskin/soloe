import { describe, expect, it } from 'vitest';
import type { MachineConnection } from '../../shared/types/connections.js';
import { isSessionDeviceConnection } from './session-device-connection.js';

describe('isSessionDeviceConnection', () => {
  it('keeps an established Device eligible while it is temporarily unavailable', () => {
    expect(isSessionDeviceConnection(machine({ status: 'unavailable' }))).toBe(true);
  });

  it('excludes a Device when the user disables its Connection', () => {
    expect(isSessionDeviceConnection(machine({ enabled: false }))).toBe(false);
  });
});

function machine(patch: Partial<MachineConnection> = {}): MachineConnection {
  return {
    id: 'device:22222222-2222-4222-8222-222222222222',
    name: 'xps',
    endpoint: 'https://xps.example.test:41730',
    endpointAliases: [],
    source: 'discovered',
    status: 'available',
    trust: 'pinned',
    enabled: true,
    active: false,
    isSelf: false,
    deviceId: '22222222-2222-4222-8222-222222222222',
    compatibility: {
      status: 'compatible',
      negotiatedVersion: 1
    },
    ...patch
  };
}
