import { describe, expect, it, vi } from 'vitest';
import {
  normalizeTailscaleDnsName,
  parseTailscaleStatus,
  TailscaleDiscovery
} from './TailscaleDiscovery.js';

describe('TailscaleDiscovery', () => {
  it('reads exact normalized MagicDNS names and online tailnet devices', () => {
    const result = parseTailscaleStatus(JSON.stringify({
      BackendState: 'Running',
      CurrentTailnet: { Name: 'example.com' },
      Self: {
        HostName: 'Client Mac',
        DNSName: 'Client-Mac.tail1234.ts.net.',
        OS: 'macOS'
      },
      Peer: {
        alpha: {
          HostName: 'Alpha',
          DNSName: 'Alpha.tail1234.ts.net.',
          Online: true,
          OS: 'linux'
        },
        offline: {
          HostName: 'Offline',
          DNSName: 'offline.tail1234.ts.net.',
          Online: false
        },
        malformed: {
          HostName: 'Malformed',
          DNSName: '.ts.net',
          Online: true
        }
      }
    }));

    expect(result).toEqual({
      state: 'connected',
      tailnet: 'example.com',
      selfDnsName: 'client-mac.tail1234.ts.net',
      message: null,
      devices: [
        {
          name: 'Client Mac',
          dnsName: 'client-mac.tail1234.ts.net',
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
    });
  });

  it('reports a signed-out or stopped Tailscale backend without probing peers', () => {
    expect(parseTailscaleStatus(JSON.stringify({
      BackendState: 'NeedsLogin',
      CurrentTailnet: { Name: 'example.com' }
    }))).toEqual({
      state: 'not-running',
      tailnet: 'example.com',
      selfDnsName: null,
      message: 'Tailscale is needslogin.',
      devices: []
    });
  });

  it('distinguishes a missing Tailscale CLI from malformed status output', async () => {
    const missing = new TailscaleDiscovery(async () => {
      const error = new Error('missing') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    await expect(missing.discover()).resolves.toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('Tailscale CLI was not found')
    });

    const malformed = new TailscaleDiscovery(async () => '{');
    await expect(malformed.discover()).resolves.toMatchObject({
      state: 'error',
      message: expect.stringContaining('Invalid Tailscale status JSON')
    });
  });

  it('automatically prepares Soloe sharing after Tailscale is connected', async () => {
    const ensureSharing = vi.fn(async () => ({
      state: 'ready' as const,
      message: null,
      setupUrl: null
    }));
    const discovery = new TailscaleDiscovery(async () => JSON.stringify({
      BackendState: 'Running',
      CurrentTailnet: { Name: 'example.com' },
      Self: {
        HostName: 'Client Mac',
        DNSName: 'client-mac.tail1234.ts.net.'
      },
      Peer: {}
    }), ensureSharing);

    await expect(discovery.discover()).resolves.toMatchObject({
      state: 'connected',
      sharing: { state: 'ready', message: null, setupUrl: null }
    });
    expect(ensureSharing).toHaveBeenCalledOnce();
  });

  it('does not attempt Serve setup before the user signs in to Tailscale', async () => {
    const ensureSharing = vi.fn();
    const discovery = new TailscaleDiscovery(async () => JSON.stringify({
      BackendState: 'NeedsLogin'
    }), ensureSharing);

    await expect(discovery.discover()).resolves.toMatchObject({
      state: 'not-running',
      sharing: {
        state: 'not-running',
        message: expect.stringContaining('sign in')
      }
    });
    expect(ensureSharing).not.toHaveBeenCalled();
  });

  it('rejects wildcard, incomplete, and malformed MagicDNS hostnames', () => {
    expect(normalizeTailscaleDnsName('Machine.tail1234.ts.net.')).toBe(
      'machine.tail1234.ts.net'
    );
    expect(normalizeTailscaleDnsName('*.tail1234.ts.net')).toBeNull();
    expect(normalizeTailscaleDnsName('.ts.net')).toBeNull();
    expect(normalizeTailscaleDnsName('-machine.tail1234.ts.net')).toBeNull();
  });
});
