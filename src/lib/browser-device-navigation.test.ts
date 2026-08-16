import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deviceSessions } from '../stores/device-sessions.svelte';
import type { BrowserTargetDevice } from '@shared/types/browser-sessions.js';
import { resolveDeviceBrowserUrl } from './browser-device-navigation';

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
});
