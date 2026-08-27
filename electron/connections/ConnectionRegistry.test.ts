import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceDescriptor } from '@shared/types/devices.js';
import type { TailscaleDiscoveryResult } from './TailscaleDiscovery.js';
import {
  ConnectionIdentityMismatchError,
  ConnectionRegistry,
  connectionIdForEndpoint,
  deviceConnectionId,
  normalizeSoloeEndpoint
} from './ConnectionRegistry.js';

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';

const CONNECTED: TailscaleDiscoveryResult = {
  state: 'connected',
  tailnet: 'example.com',
  selfDnsName: 'client.tail1234.ts.net',
  selfIpAddress: '100.64.0.1',
  message: null,
  sharing: { state: 'ready', message: null, setupUrl: null },
  devices: [
    {
      name: 'Client',
      dnsName: 'client.tail1234.ts.net',
    online: true,
    isSelf: true,
    ipAddress: '100.64.0.1',
      os: 'macOS'
    },
    {
      name: 'Alpha',
      dnsName: 'alpha.tail1234.ts.net',
    online: true,
    isSelf: false,
    ipAddress: '100.64.0.2',
      os: 'linux'
    },
    {
      name: 'Offline',
      dnsName: 'offline.tail1234.ts.net',
    online: false,
    isSelf: false,
    ipAddress: '100.64.0.3'
    }
  ]
};

describe('ConnectionRegistry', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-connections-'));
    filePath = path.join(directory, 'connections.json');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('discovers only online peers that are actually serving Soloe', async () => {
    const probe = vi.fn(async (endpoint: string) => endpoint.includes('alpha'));
    const registry = createRegistry({ probe, discover: async () => CONNECTED });

    const snapshot = await registry.refresh();

    expect(snapshot.tailscale).toMatchObject({
      state: 'connected',
      tailnet: 'example.com',
      selfDnsName: 'client.tail1234.ts.net'
    });
    expect(snapshot.machines).toEqual([
      expect.objectContaining({ id: 'local', name: 'Test Mac', active: true }),
      expect.objectContaining({
        id: 'tailscale:alpha.tail1234.ts.net',
        name: 'Alpha',
        endpoint: 'https://alpha.tail1234.ts.net',
        source: 'discovered',
        status: 'available'
      })
    ]);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('upgrades a discovered endpoint to its authenticated durable Device identity', async () => {
    const registry = createRegistry({
      probe: async () => true,
      discover: async () => CONNECTED,
      describe: async () => ({
        descriptor: descriptor(DEVICE_A, 'Authenticated Alpha'),
        compatibility: { status: 'compatible', negotiatedVersion: 1 }
      })
    });

    const snapshot = await registry.refresh();

    expect(snapshot.machines).toContainEqual(expect.objectContaining({
      id: deviceConnectionId(DEVICE_A),
      deviceId: DEVICE_A,
      name: 'Authenticated Alpha',
      trust: 'pinned'
    }));
  });

  it('automatically connects compatible discovered Devices and persists them', async () => {
    const registry = createRegistry({
      probe: async () => true,
      discover: async () => CONNECTED,
      describe: async () => ({
        descriptor: descriptor(DEVICE_A, 'Authenticated Alpha'),
        compatibility: { status: 'compatible', negotiatedVersion: 1 }
      })
    });
    const discovered = await registry.refresh();
    const id = deviceConnectionId(DEVICE_A);
    expect(discovered.machines.find((machine) => machine.id === id)?.enabled).toBe(true);

    const restarted = createRegistry();
    await restarted.init();

    expect((await restarted.get()).machines.find((machine) => machine.id === id)).toMatchObject({
      deviceId: DEVICE_A,
      enabled: true
    });
  });

  it('does not connect a discovered Device that requires an update', async () => {
    const registry = createRegistry({
      probe: async () => true,
      discover: async () => CONNECTED,
      describe: async () => ({
        descriptor: descriptor(DEVICE_A, 'Old Alpha'),
        compatibility: { status: 'device-upgrade-required', negotiatedVersion: null }
      })
    });

    const snapshot = await registry.refresh();

    expect(snapshot.machines).toContainEqual(expect.objectContaining({
      id: deviceConnectionId(DEVICE_A),
      enabled: false,
      compatibility: expect.objectContaining({ status: 'device-upgrade-required' })
    }));
  });

  it('reports a Device update instead of exposing missing multi-Device capabilities', async () => {
    const old = descriptor(DEVICE_A, 'Old Alpha');
    old.capabilities.features = ['device.describe.v1'];
    const registry = createRegistry({
      probe: async () => true,
      discover: async () => CONNECTED,
      describe: async () => ({
        descriptor: old,
        compatibility: { status: 'compatible', negotiatedVersion: 1 }
      })
    });

    const snapshot = await registry.refresh();

    expect(snapshot.machines).toContainEqual(expect.objectContaining({
      id: deviceConnectionId(DEVICE_A),
      enabled: false,
      updateRequired: true
    }));
  });

  it('requires the Sessions inventory capability before connecting a discovered Device', async () => {
    const old = descriptor(DEVICE_A, 'Old Alpha');
    old.capabilities.features = old.capabilities.features.filter(
      (feature) => feature !== 'sessions.multi-device.v1'
    );
    const registry = createRegistry({
      probe: async () => true,
      discover: async () => CONNECTED,
      describe: async () => ({
        descriptor: old,
        compatibility: { status: 'compatible', negotiatedVersion: 1 }
      })
    });

    const snapshot = await registry.refresh();

    expect(snapshot.machines).toContainEqual(expect.objectContaining({
      id: deviceConnectionId(DEVICE_A),
      enabled: false,
      updateRequired: true
    }));
  });

  it('does not apply remote capability requirements to the running local Device', async () => {
    const local = descriptor(DEVICE_A, 'Studio Mac');
    local.capabilities.features = ['workspace-device.v1'];
    const registry = createRegistry();

    const snapshot = await registry.bindLocalDescriptor(local);

    expect(snapshot.machines).toContainEqual(expect.objectContaining({
      id: 'local',
      enabled: true,
      updateRequired: false
    }));
  });

  it('adopts a new backend-owned identity after a discovered machine is reset', async () => {
    let advertisedDeviceId = DEVICE_A;
    const registry = createRegistry({
      probe: async () => true,
      discover: async () => CONNECTED,
      describe: async () => ({
        descriptor: descriptor(advertisedDeviceId, 'Authenticated Alpha'),
        compatibility: { status: 'compatible', negotiatedVersion: 1 }
      })
    });
    await registry.refresh();

    advertisedDeviceId = DEVICE_B;
    const reset = await registry.refresh();

    expect(reset.machines).toContainEqual(expect.objectContaining({
      id: deviceConnectionId(DEVICE_B),
      deviceId: DEVICE_B,
      enabled: true,
      trust: 'pinned'
    }));
    expect(reset.machines.some((machine) => machine.deviceId === DEVICE_A)).toBe(false);
  });

  it('persists a selected discovered machine and restores it on restart', async () => {
    const registry = createRegistry({
      discover: async () => CONNECTED,
      probe: async () => true
    });
    await registry.refresh();
    await expect(registry.select('tailscale:alpha.tail1234.ts.net')).resolves.toEqual({
      activeId: 'tailscale:alpha.tail1234.ts.net',
      relaunching: true
    });

    const restored = createRegistry({
      discover: async () => ({ ...CONNECTED, devices: [] }),
      probe: async () => false
    });
    await restored.init();

    expect(restored.activeEndpoint()).toBe('https://alpha.tail1234.ts.net');
    expect((await restored.get()).activeId).toBe('tailscale:alpha.tail1234.ts.net');
  });

  it('keeps manually added HTTPS roots even when they are temporarily unavailable', async () => {
    const registry = createRegistry({ probe: async () => false });

    const snapshot = await registry.add(' HTTPS://Build.tail1234.ts.net./ ');

    expect(snapshot.machines).toContainEqual(expect.objectContaining({
      id: 'tailscale:build.tail1234.ts.net',
      endpoint: 'https://build.tail1234.ts.net',
      source: 'manual',
      status: 'unavailable'
    }));
    await expect(registry.select('tailscale:build.tail1234.ts.net')).rejects.toThrow(
      'not currently reachable'
    );
  });

  it('validates endpoints and derives stable connection identities', () => {
    expect(normalizeSoloeEndpoint('https://Machine.tail1234.ts.net./')).toBe(
      'https://machine.tail1234.ts.net'
    );
    expect(connectionIdForEndpoint('https://machine.tail1234.ts.net')).toBe(
      'tailscale:machine.tail1234.ts.net'
    );
    expect(() => normalizeSoloeEndpoint('http://machine.tail1234.ts.net')).toThrow(
      'trusted root HTTPS address'
    );
    expect(() => normalizeSoloeEndpoint('https://machine.tail1234.ts.net/path')).toThrow(
      'trusted root HTTPS address'
    );
  });

  it('pins a durable Device identity and preserves it across endpoint renames', async () => {
    const registry = createRegistry({ probe: async () => true });
    await registry.add('https://alpha.tail1234.ts.net');
    await registry.select('tailscale:alpha.tail1234.ts.net');

    const first = await registry.bindDescriptor(
      'https://alpha.tail1234.ts.net',
      descriptor(DEVICE_A, 'Alpha')
    );
    const durableId = deviceConnectionId(DEVICE_A);
    expect(first.activeId).toBe(durableId);
    expect(first.machines).toContainEqual(expect.objectContaining({
      id: durableId,
      deviceId: DEVICE_A,
      trust: 'pinned',
      compatibility: { status: 'compatible', negotiatedVersion: 1 },
      endpointAliases: ['https://alpha.tail1234.ts.net']
    }));

    await registry.add('https://renamed.tail1234.ts.net');
    const renamed = await registry.bindDescriptor(
      'https://renamed.tail1234.ts.net',
      descriptor(DEVICE_A, 'Renamed Alpha')
    );
    expect(renamed.activeId).toBe(durableId);
    expect(renamed.machines.filter((machine) => machine.id !== 'local')).toEqual([
      expect.objectContaining({
        id: durableId,
        name: 'Renamed Alpha',
        endpoint: 'https://renamed.tail1234.ts.net',
        endpointAliases: [
          'https://alpha.tail1234.ts.net',
          'https://renamed.tail1234.ts.net'
        ]
      })
    ]);
  });

  it('persists Tailscale enablement and uses the configured Serve port', async () => {
    const discover = vi.fn(async () => CONNECTED);
    const probe = vi.fn(async () => true);
    const registry = createRegistry({ discover, probe });

    const configured = await registry.configureTailscale({ tailscaleHttpsPort: 4319 });

    expect(configured.preferences).toEqual({
      tailscaleEnabled: true,
      tailscaleHttpsPort: 4319
    });
    expect(probe).toHaveBeenCalledWith('https://alpha.tail1234.ts.net:4319');

    discover.mockClear();
    probe.mockClear();
    const disabled = await registry.configureTailscale({ tailscaleEnabled: false });

    expect(disabled.preferences.tailscaleEnabled).toBe(false);
    expect(disabled.tailscale.state).toBe('disabled');
    expect(discover).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();

    const restored = createRegistry({ discover, probe });
    await restored.init();
    expect((await restored.get()).preferences).toEqual({
      tailscaleEnabled: false,
      tailscaleHttpsPort: 4319
    });
  });

  it('publishes the short DNS state returned after helper removal', async () => {
    const removed = {
      state: 'setup-required' as const,
      zone: 'client',
      nameserver: '100.64.0.1',
      message: 'Install Soloe DNS on this Device.',
      setupUrl: null,
      readyZones: []
    };
    const remove = vi.fn(async () => removed);
    const registry = createRegistry({
      shortDns: {
        status: vi.fn(async () => removed),
        setup: vi.fn(async () => removed),
        remove
      }
    });

    const snapshot = await registry.removeShortDns();

    expect(remove).toHaveBeenCalledOnce();
    expect(snapshot.shortDns).toEqual(removed);
  });

  it('reports each reachable Device DNS helper state independently', async () => {
    const local = {
      state: 'ready' as const,
      zone: 'client',
      nameserver: '100.64.0.1',
      message: null,
      setupUrl: 'https://login.tailscale.com/admin/dns',
      readyZones: ['client']
    };
    const remote = {
      state: 'setup-required' as const,
      zone: 'alpha',
      nameserver: '100.64.0.2',
      message: 'Install Soloe DNS on this Device.',
      setupUrl: null,
      readyZones: []
    };
    const statusFor = vi.fn(async () => remote);
    const registry = createRegistry({
      discover: async () => CONNECTED,
      probe: async () => true,
      shortDns: {
        status: vi.fn(async () => local),
        statusFor,
        setup: vi.fn(async () => local),
        remove: vi.fn(async () => local)
      }
    });

    const snapshot = await registry.refresh();

    expect(statusFor).toHaveBeenCalledWith('alpha', '100.64.0.2');
    expect(snapshot.machines.find((machine) => machine.endpoint?.includes('alpha'))?.shortDns)
      .toEqual(remote);
  });

  it('routes DNS setup to the selected remote Device', async () => {
    const installed = {
      state: 'route-required' as const,
      zone: 'alpha',
      nameserver: '100.64.0.2',
      message: 'Approve the route.',
      setupUrl: 'https://login.tailscale.com/admin/dns',
      readyZones: []
    };
    const setup = vi.fn(async () => installed);
    const registry = createRegistry({
      probe: async () => true,
      remoteShortDns: { setup, remove: vi.fn() }
    });
    await registry.add('https://alpha.tail1234.ts.net');
    const bound = await registry.bindDescriptor(
      'https://alpha.tail1234.ts.net',
      descriptor(DEVICE_A, 'Alpha')
    );
    const target = bound.machines.find((machine) => machine.deviceId === DEVICE_A)!;

    const snapshot = await registry.setupShortDns(target.id);

    expect(setup).toHaveBeenCalledWith(expect.objectContaining({
      id: target.id,
      deviceId: DEVICE_A,
      name: 'Alpha'
    }));
    expect(snapshot.machines.find((machine) => machine.id === target.id)?.shortDns)
      .toEqual(installed);
  });

  it('blocks an endpoint that changes its pinned Device identity', async () => {
    const registry = createRegistry({ probe: async () => true });
    await registry.add('https://alpha.tail1234.ts.net');
    await registry.bindDescriptor(
      'https://alpha.tail1234.ts.net',
      descriptor(DEVICE_A, 'Alpha')
    );

    await expect(registry.bindDescriptor(
      'https://alpha.tail1234.ts.net',
      descriptor(DEVICE_B, 'Impostor')
    )).rejects.toBeInstanceOf(ConnectionIdentityMismatchError);

    const id = deviceConnectionId(DEVICE_A);
    expect((await registry.get()).machines).toContainEqual(expect.objectContaining({
      id,
      deviceId: DEVICE_A,
      observedDeviceId: DEVICE_B,
      trust: 'identity-mismatch'
    }));
    await expect(registry.select(id)).rejects.toThrow('pinned Device identity');
  });

  it('migrates v1 atomically, retains the active endpoint, and writes a rollback fixture', async () => {
    const legacy = `${JSON.stringify({
      version: 1,
      activeId: 'tailscale:alpha.tail1234.ts.net',
      machines: [{
        id: 'tailscale:alpha.tail1234.ts.net',
        name: 'Alpha',
        endpoint: 'https://alpha.tail1234.ts.net',
        source: 'discovered',
        os: 'linux',
        lastSeenAt: '2026-08-11T12:00:00.000Z'
      }]
    }, null, 2)}\n`;
    await fs.writeFile(filePath, legacy, 'utf8');
    const registry = createRegistry();

    await registry.init();

    expect(registry.activeEndpoint()).toBe('https://alpha.tail1234.ts.net');
    expect(await fs.readFile(`${filePath}.v1.bak`, 'utf8')).toBe(legacy);
    const migrated = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      version: number;
      activeId: string;
      machines: Array<Record<string, unknown>>;
    };
    expect(migrated).toMatchObject({
      version: 3,
      activeId: 'tailscale:alpha.tail1234.ts.net',
      preferences: {
        tailscaleEnabled: true,
        tailscaleHttpsPort: 443
      },
      machines: [{
        trust: 'provisional',
        endpointAliases: ['https://alpha.tail1234.ts.net']
      }]
    });
  });

  it('keeps the legacy active Device enabled when loading an early v2 registry', async () => {
    const id = `device:${DEVICE_A}` as const;
    await fs.writeFile(filePath, JSON.stringify({
      version: 2,
      activeId: id,
      machines: [{
        id,
        name: 'Alpha',
        endpoint: 'https://alpha.tail1234.ts.net',
        endpointAliases: ['https://alpha.tail1234.ts.net'],
        source: 'manual',
        trust: 'pinned',
        deviceId: DEVICE_A
      }]
    }), 'utf8');

    const registry = createRegistry();
    await registry.init();

    expect((await registry.get()).machines).toContainEqual(expect.objectContaining({
      id,
      active: true,
      enabled: true
    }));
  });

  function createRegistry(overrides: {
    discover?: () => Promise<TailscaleDiscoveryResult>;
    probe?: (endpoint: string) => Promise<boolean>;
    describe?: ConstructorParameters<typeof ConnectionRegistry>[0]['describe'];
    shortDns?: NonNullable<ConstructorParameters<typeof ConnectionRegistry>[0]['shortDns']>;
    remoteShortDns?: NonNullable<ConstructorParameters<typeof ConnectionRegistry>[0]['remoteShortDns']>;
  } = {}): ConnectionRegistry {
    return new ConnectionRegistry({
      filePath,
      localName: 'Test Mac',
      discover: overrides.discover ?? (async () => ({
        state: 'unavailable',
        tailnet: null,
        selfDnsName: null,
        selfIpAddress: null,
        message: 'not installed',
        devices: [],
        sharing: {
          state: 'unavailable',
          message: 'Install Tailscale to connect Devices.',
          setupUrl: 'https://tailscale.com/download'
        }
      })),
      probe: overrides.probe ?? (async () => false),
      ...(overrides.describe ? { describe: overrides.describe } : {}),
      ...(overrides.shortDns ? { shortDns: overrides.shortDns } : {}),
      ...(overrides.remoteShortDns ? { remoteShortDns: overrides.remoteShortDns } : {}),
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
  }

  function descriptor(deviceId: string, name: string): DeviceDescriptor {
    return {
      schemaVersion: 1,
      deviceId,
      name,
      platform: 'linux',
      serverEpoch: '33333333-3333-4333-8333-333333333333',
      service: { name: 'soloe-server', version: '0.1.0' },
      protocol: { current: 1, minimum: 1, maximum: 1 },
      capabilities: {
        revision: 'capability-revision-1',
        features: [
          'device.describe.v1',
          'device.snapshot.v1',
          'events.envelope.v1',
          'sessions.multi-device.v1',
          'runtime.sessions.v1',
          'runtime.terminal-input-lease.v1',
          'runtime.terminal-replay.v1',
          'workspace-device.v1',
          'workspace-placement-plan.v1'
        ]
      }
    };
  }
});
