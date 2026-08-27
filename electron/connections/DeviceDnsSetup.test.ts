import { describe, expect, it, vi } from 'vitest';
import {
  DeviceDnsSetup,
  deviceZone,
  linuxDeviceDnsRemovalScript,
  macosDeviceDnsRemovalCommand,
  validTailscaleIpv4,
  windowsDeviceDnsRemovalScript
} from './DeviceDnsSetup.js';

const identity = {
  enabled: true,
  connected: true,
  selfDnsName: 'XPS.tail1234.ts.net',
  selfIpAddress: '100.99.182.95'
};

describe('DeviceDnsSetup', () => {
  it('reports setup, route approval, and ready as separate verified states', async () => {
    let serviceReady = false;
    let routeReady = false;
    const install = vi.fn(async () => { serviceReady = true; });
    const setup = new DeviceDnsSetup({
      helperPath: '/tmp/soloe-device-dns',
      resolveDirect: async () => serviceReady ? ['100.99.182.95'] : [],
      resolveSystem: async () => routeReady ? ['100.99.182.95'] : [],
      install
    });

    await expect(setup.status(identity)).resolves.toMatchObject({ state: 'setup-required', zone: 'xps' });
    await expect(setup.setup()).resolves.toMatchObject({ state: 'route-required', setupUrl: expect.stringContaining('tailscale.com') });
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ zone: 'xps', nameserver: '100.99.182.95' }));
    routeReady = true;
    await expect(setup.status(identity)).resolves.toMatchObject({ state: 'ready' });
  });

  it('does not install before Tailscale has a valid identity', async () => {
    const install = vi.fn();
    const setup = new DeviceDnsSetup({ helperPath: '/missing', install });
    await expect(setup.status({ ...identity, connected: false })).resolves.toMatchObject({ state: 'unavailable' });
    await expect(setup.setup()).resolves.toMatchObject({ state: 'unavailable' });
    expect(install).not.toHaveBeenCalled();
  });

  it('removes the helper only after the restricted DNS route is absent', async () => {
    let serviceReady = true;
    let routeReady = true;
    const remove = vi.fn(async () => { serviceReady = false; });
    const setup = new DeviceDnsSetup({
      helperPath: '/tmp/soloe-device-dns',
      resolveDirect: async () => serviceReady ? ['100.99.182.95'] : [],
      resolveSystem: async () => routeReady ? ['100.99.182.95'] : [],
      remove
    });

    await setup.status(identity);
    await expect(setup.remove()).rejects.toThrow(/restricted DNS route/i);
    expect(remove).not.toHaveBeenCalled();

    routeReady = false;
    await expect(setup.remove()).resolves.toMatchObject({ state: 'setup-required' });
    expect(remove).toHaveBeenCalledOnce();

    await expect(setup.remove()).resolves.toMatchObject({ state: 'setup-required' });
    expect(remove).toHaveBeenCalledOnce();
  });

  it('builds idempotent removal commands for every supported platform', () => {
    expect(linuxDeviceDnsRemovalScript()).toContain('systemctl disable --now soloe-device-dns.service');
    expect(linuxDeviceDnsRemovalScript()).toContain('rm -f /etc/systemd/system/soloe-device-dns.service');
    expect(linuxDeviceDnsRemovalScript()).toContain('rm -f /usr/local/libexec/soloe-device-dns');
    expect(linuxDeviceDnsRemovalScript()).toContain('systemctl daemon-reload');

    expect(macosDeviceDnsRemovalCommand()).toContain('launchctl bootout system/com.soloe.device-dns');
    expect(macosDeviceDnsRemovalCommand()).toContain("rm -f '/Library/LaunchDaemons/com.soloe.device-dns.plist'");
    expect(macosDeviceDnsRemovalCommand()).toContain("rm -f '/Library/Application Support/Soloe/soloe-device-dns'");

    expect(windowsDeviceDnsRemovalScript()).toContain('sc.exe stop SoloeDeviceDns');
    expect(windowsDeviceDnsRemovalScript()).toContain('sc.exe delete SoloeDeviceDns');
    expect(windowsDeviceDnsRemovalScript()).toContain("Remove-Item -Force -LiteralPath $destination");
  });

  it('verifies private routes independently for every Device zone', async () => {
    const setup = new DeviceDnsSetup({
      helperPath: '/tmp/soloe-device-dns',
      resolveSystem: async (hostname) => hostname.endsWith('.xps') ? ['100.64.0.1'] : []
    });

    await expect(setup.resolvedZones([
      { zone: 'xps', nameserver: '100.64.0.1' },
      { zone: 'mbp', nameserver: '100.64.0.2' },
      { zone: 'bad.zone', nameserver: '100.64.0.3' }
    ])).resolves.toEqual(['xps']);
  });

  it('normalizes only safe single-label zones and Tailscale IPv4 addresses', () => {
    expect(deviceZone('MBP.tail.ts.net')).toBe('mbp');
    expect(deviceZone('-bad.tail.ts.net')).toBeNull();
    expect(validTailscaleIpv4('100.64.0.1')).toBe('100.64.0.1');
    expect(validTailscaleIpv4('100.1.0.1')).toBeNull();
    expect(validTailscaleIpv4('192.168.1.2')).toBeNull();
  });
});
