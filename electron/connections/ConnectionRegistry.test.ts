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
  message: null,
  devices: [
    {
      name: 'Client',
      dnsName: 'client.tail1234.ts.net',
      online: true,
      isSelf: true,
      os: 'macOS'
    },
    {
      name: 'Alpha',
      dnsName: 'alpha.tail1234.ts.net',
      online: true,
      isSelf: false,
      os: 'linux'
    },
    {
      name: 'Offline',
      dnsName: 'offline.tail1234.ts.net',
      online: false,
      isSelf: false
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

  it('persists explicit enablement separately from Device discovery', async () => {
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
    expect(discovered.machines.find((machine) => machine.id === id)?.enabled).toBe(false);

    await registry.setEnabled(id, true);
    const restarted = createRegistry();
    await restarted.init();

    expect((await restarted.get()).machines.find((machine) => machine.id === id)).toMatchObject({
      deviceId: DEVICE_A,
      enabled: true
    });
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
      version: 2,
      activeId: 'tailscale:alpha.tail1234.ts.net',
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
  } = {}): ConnectionRegistry {
    return new ConnectionRegistry({
      filePath,
      localName: 'Test Mac',
      discover: overrides.discover ?? (async () => ({
        state: 'unavailable',
        tailnet: null,
        selfDnsName: null,
        message: 'not installed',
        devices: []
      })),
      probe: overrides.probe ?? (async () => false),
      ...(overrides.describe ? { describe: overrides.describe } : {}),
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
        features: ['device.describe.v1']
      }
    };
  }
});
