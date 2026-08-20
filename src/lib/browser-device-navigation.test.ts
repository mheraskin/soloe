import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceSessions } from '../stores/device-sessions.svelte';
import { connections } from '../stores/connections.svelte';
import type { BrowserTargetDevice } from '@shared/types/browser-sessions.js';
import { resolveDeviceBrowserUrl, tailscaleDnsNameForDevice } from './browser-device-navigation';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const target: BrowserTargetDevice = {
  deviceId: DEVICE_ID,
  name: 'XPS',
  tailscaleDnsName: 'xps.example.ts.net',
  local: false
};

describe('resolveDeviceBrowserUrl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rewrites a loopback URL through the selected Device without losing URL parts', async () => {
    vi.spyOn(deviceSessions, 'ensureTailscalePort').mockResolvedValue({
      deviceId: DEVICE_ID,
      state: 'ready',
      dnsName: 'xps.example.ts.net',
      port: 3000,
      forwarded: true,
      message: null,
      setupUrl: null
    });

    await expect(resolveDeviceBrowserUrl(
      'http://localhost:3000/path?q=yes#result',
      target
    )).resolves.toEqual({
      url: 'http://xps.example.ts.net:3000/path?q=yes#result',
      target
    });
    expect(deviceSessions.ensureTailscalePort).toHaveBeenCalledWith(DEVICE_ID, 3000);
  });

  it('leaves public URLs alone', async () => {
    const ensure = vi.spyOn(deviceSessions, 'ensureTailscalePort');
    await expect(resolveDeviceBrowserUrl('https://example.com/docs', target)).resolves.toEqual({
      url: 'https://example.com/docs',
      target
    });
    await expect(resolveDeviceBrowserUrl(
      'http://attacker-xps.example.ts.net:8877/order-ahead/',
      target
    )).resolves.toEqual({
      url: 'http://attacker-xps.example.ts.net:8877/order-ahead/',
      target
    });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('ensures an explicitly entered MagicDNS URL is forwarded', async () => {
    vi.spyOn(deviceSessions, 'ensureTailscalePort').mockResolvedValue({
      deviceId: DEVICE_ID,
      state: 'ready',
      dnsName: 'xps.example.ts.net',
      port: 5173,
      forwarded: true,
      message: null,
      setupUrl: null
    });

    await expect(resolveDeviceBrowserUrl('xps.example.ts.net:5173', target))
      .resolves.toMatchObject({ url: 'http://xps.example.ts.net:5173/' });
  });

  it('routes a Device MagicDNS subdomain through the resolvable Device hostname', async () => {
    vi.spyOn(deviceSessions, 'ensureTailscalePort').mockResolvedValue({
      deviceId: DEVICE_ID,
      state: 'ready',
      dnsName: 'xps.example.ts.net',
      ipAddress: '100.101.102.103',
      port: 8877,
      forwarded: true,
      message: null,
      setupUrl: null
    });

    await expect(resolveDeviceBrowserUrl(
      'http://ember-oak.xps.example.ts.net:8877/order-ahead/',
      target
    )).resolves.toEqual({
      url: 'http://ember-oak.100.101.102.103.nip.io:8877/order-ahead/',
      target
    });
    expect(deviceSessions.ensureTailscalePort).toHaveBeenCalledWith(DEVICE_ID, 8877);
  });

  it('preserves a localhost subdomain when routing it to another Device', async () => {
    vi.spyOn(deviceSessions, 'ensureTailscalePort').mockResolvedValue({
      deviceId: DEVICE_ID,
      state: 'ready',
      dnsName: 'xps.example.ts.net',
      ipAddress: '100.101.102.103',
      port: 8877,
      forwarded: true,
      message: null,
      setupUrl: null
    });

    await expect(resolveDeviceBrowserUrl(
      'http://ember-oak.localhost:8877/order-ahead/?menu=lunch#items',
      target
    )).resolves.toMatchObject({
      url: 'http://ember-oak.100.101.102.103.nip.io:8877/order-ahead/?menu=lunch#items'
    });
  });

  it('fails explicitly when an older Device cannot provide an address for a subdomain', async () => {
    vi.spyOn(deviceSessions, 'ensureTailscalePort').mockResolvedValue({
      deviceId: DEVICE_ID,
      state: 'ready',
      dnsName: 'xps.example.ts.net',
      port: 8877,
      forwarded: true,
      message: null,
      setupUrl: null
    });

    await expect(resolveDeviceBrowserUrl(
      'http://ember-oak.localhost:8877/order-ahead/',
      target
    )).rejects.toThrow('did not report a Tailscale IPv4 address');
  });

  it('resolves the local DNS name and remote endpoint aliases for device labels', () => {
    const snapshot = connections.snapshot;
    connections.snapshot = {
      ...snapshot,
      tailscale: { ...snapshot.tailscale, selfDnsName: 'MBP.tail1234.ts.net.' },
      machines: [{
        id: 'device:xps',
        name: 'XPS',
        endpoint: 'https://xps.tail1234.ts.net:4318',
        endpointAliases: ['xps.local'],
        source: 'discovered',
        status: 'available',
        trust: 'pinned',
        enabled: true,
        active: false,
        isSelf: false,
        deviceId: DEVICE_ID
      }]
    };

    expect(tailscaleDnsNameForDevice('local', true)).toBe('mbp.tail1234.ts.net');
    expect(tailscaleDnsNameForDevice(DEVICE_ID, false)).toBe('xps.tail1234.ts.net');

    connections.snapshot = snapshot;
  });
});
