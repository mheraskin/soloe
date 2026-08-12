import { describe, expect, it } from 'vitest';

import {
  negotiateDeviceProtocol,
  parseDeviceDescriptor,
  type DeviceDescriptor
} from './devices.js';

const DESCRIPTOR: DeviceDescriptor = {
  schemaVersion: 1,
  deviceId: '11111111-1111-4111-8111-111111111111',
  name: 'Build Mac',
  platform: 'macos',
  serverEpoch: '22222222-2222-4222-8222-222222222222',
  service: { name: 'soloe-server', version: '0.1.0' },
  protocol: { current: 2, minimum: 1, maximum: 2 },
  capabilities: {
    revision: 'abc123',
    features: ['device.describe.v1', 'events.envelope.v1']
  }
};

describe('Device contracts', () => {
  it('strictly parses a bounded descriptor', () => {
    expect(parseDeviceDescriptor(DESCRIPTOR)).toEqual(DESCRIPTOR);
    expect(() => parseDeviceDescriptor({ ...DESCRIPTOR, deviceId: 'hostname-derived' })).toThrow(
      'deviceId is invalid'
    );
    expect(() => parseDeviceDescriptor({
      ...DESCRIPTOR,
      capabilities: { ...DESCRIPTOR.capabilities, features: ['duplicate', 'duplicate'] }
    })).toThrow('must be unique');
    expect(() => parseDeviceDescriptor({
      ...DESCRIPTOR,
      protocol: { current: 2, minimum: 3, maximum: 2 }
    })).toThrow('protocol range is invalid');
  });

  it.each([
    [
      { current: 2, minimum: 1, maximum: 2 },
      { current: 3, minimum: 2, maximum: 3 },
      { status: 'compatible', negotiatedVersion: 2 }
    ],
    [
      { current: 1, minimum: 1, maximum: 1 },
      { current: 3, minimum: 2, maximum: 3 },
      { status: 'device-upgrade-required', negotiatedVersion: null }
    ],
    [
      { current: 4, minimum: 4, maximum: 4 },
      { current: 3, minimum: 2, maximum: 3 },
      { status: 'client-upgrade-required', negotiatedVersion: null }
    ]
  ] as const)('negotiates the protocol min/max matrix', (device, client, expected) => {
    expect(negotiateDeviceProtocol(device, client)).toEqual(expected);
  });
});
