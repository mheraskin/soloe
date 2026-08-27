import { describe, expect, it } from 'vitest';
import type { MachineConnection, ShortDnsInfo } from '@shared/types/connections.js';
import {
  connectionDevicePresentation,
  connectionDevices,
  connectionDiscoverySummary,
  connectionShortUrlPresentation
} from './device-presentation.js';

describe('connection device presentation', () => {
  it('always presents the current machine as online', () => {
    expect(connectionDevicePresentation(machine({
      id: 'local',
      source: 'local',
      status: 'available',
      trust: 'local'
    }))).toMatchObject({ status: 'Online', tone: 'online', isLocal: true });
  });

  it('lists the current machine before discovered machines', () => {
    const remote = machine({ id: 'tailscale:alpha', source: 'discovered', name: 'Alpha' });
    const local = machine({ id: 'local', source: 'local', name: 'This Mac' });
    expect(connectionDevices([remote, local]).map((item) => item.name)).toEqual([
      'This Mac',
      'Alpha'
    ]);
  });

  it('summarizes other devices in user-facing language', () => {
    expect(connectionDiscoverySummary([
      machine({ id: 'local', source: 'local', status: 'available', trust: 'local' }),
      machine({
        id: 'tailscale:alpha',
        source: 'discovered',
        status: 'available',
        trust: 'pinned',
        deviceId: '11111111-1111-4111-8111-111111111111'
      })
    ])).toBe('1 other Soloe device found · online');
  });

  it('labels an old discovered endpoint as an update instead of exposing protocol details', () => {
    expect(connectionDevicePresentation(machine({
      id: 'tailscale:old-laptop',
      name: 'LAPTOPLORES',
      status: 'available',
      trust: 'provisional'
    }))).toMatchObject({ status: 'Update Soloe', tone: 'update', isLocal: false });
  });

  it('labels an unreachable pinned Device as offline', () => {
    expect(connectionDevicePresentation(machine({
      id: 'device:11111111-1111-4111-8111-111111111111',
      deviceId: '11111111-1111-4111-8111-111111111111',
      trust: 'pinned',
      status: 'unavailable'
    }))).toMatchObject({ status: 'Offline', tone: 'offline', isLocal: false });
  });

  it('shows a verified short URL for a discovered Device zone', () => {
    expect(connectionShortUrlPresentation(machine({
      endpoint: 'https://xps.tailnet.ts.net:443'
    }), shortDns({ readyZones: ['xps'] }))).toEqual({
      status: 'Short URL ready',
      tone: 'ready',
      zone: 'xps'
    });
  });

  it('shows the nip.io fallback when a discovered Device zone is not ready', () => {
    expect(connectionShortUrlPresentation(machine({
      endpoint: 'https://xps.tailnet.ts.net:443'
    }), shortDns())).toEqual({
      status: 'nip.io fallback',
      tone: 'attention',
      zone: 'xps'
    });
  });

  it('shows the remote DNS setup action reported by that Device', () => {
    expect(connectionShortUrlPresentation(machine({
      endpoint: 'https://xps.tailnet.ts.net:443',
      shortDns: shortDns({ state: 'setup-required', zone: 'xps', readyZones: [] })
    }), shortDns())).toEqual({
      status: 'Install DNS',
      tone: 'attention',
      zone: 'xps'
    });
  });

  it('shows the local DNS setup action', () => {
    expect(connectionShortUrlPresentation(machine({
      id: 'local',
      source: 'local',
      isSelf: true
    }), shortDns({ state: 'setup-required', zone: 'macbook' }))).toEqual({
      status: 'Install DNS',
      tone: 'attention',
      zone: 'macbook'
    });
  });

  it('shows the local Tailscale route action', () => {
    expect(connectionShortUrlPresentation(machine({
      id: 'local',
      source: 'local',
      isSelf: true
    }), shortDns({ state: 'route-required', zone: 'macbook' }))).toEqual({
      status: 'Approve DNS route',
      tone: 'attention',
      zone: 'macbook'
    });
  });
});

function machine(overrides: Partial<MachineConnection>): MachineConnection {
  return {
    id: 'tailscale:device.example.test',
    name: 'Device',
    endpoint: 'https://device.example.test',
    endpointAliases: [],
    enabled: true,
    active: false,
    isSelf: false,
    source: 'discovered',
    status: 'unavailable',
    trust: 'provisional',
    ...overrides
  };
}

function shortDns(overrides: Partial<ShortDnsInfo> = {}): ShortDnsInfo {
  return {
    state: 'ready',
    zone: 'macbook',
    nameserver: '100.64.0.1',
    message: null,
    setupUrl: null,
    readyZones: [],
    ...overrides
  };
}
