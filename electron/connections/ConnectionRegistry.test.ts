import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailscaleDiscoveryResult } from './TailscaleDiscovery.js';
import {
  ConnectionRegistry,
  connectionIdForEndpoint,
  normalizeSoloeEndpoint
} from './ConnectionRegistry.js';

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

  function createRegistry(overrides: {
    discover?: () => Promise<TailscaleDiscoveryResult>;
    probe?: (endpoint: string) => Promise<boolean>;
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
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
  }
});
