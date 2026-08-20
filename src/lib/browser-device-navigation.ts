import type { DeviceId } from '@shared/types/devices.js';
import type { BrowserTargetDevice } from '@shared/types/browser-sessions.js';
import { browserStore } from '../stores/browser.svelte';
import { connections } from '../stores/connections.svelte';
import { deviceSessions } from '../stores/device-sessions.svelte';
import { rightRail } from '../stores/right-rail.svelte';
import {
  browserUrlPort,
  isLoopbackBrowserHostname,
  normalizeBrowserUrl
} from './browser-navigation';

export interface BrowserTargetOption {
  target: BrowserTargetDevice;
  available: boolean;
  state: string;
}

export function browserTargetOptions(): BrowserTargetOption[] {
  return deviceSessions.state.devices.map((device) => ({
    target: {
      deviceId: device.deviceId,
      name: device.name,
      tailscaleDnsName: tailscaleDnsNameForDevice(device.deviceId, device.local),
      local: device.local
    },
    available: device.available,
    state: device.state
  }));
}

export function browserTargetForDevice(deviceId: DeviceId): BrowserTargetDevice | null {
  return browserTargetOptions().find((option) => option.target.deviceId === deviceId)?.target ?? null;
}

export function defaultBrowserTarget(): BrowserTargetDevice | null {
  const local = deviceSessions.localDevice;
  return local ? browserTargetForDevice(local.deviceId) : null;
}

export async function resolveDeviceBrowserUrl(
  rawUrl: string,
  requestedTarget: BrowserTargetDevice | null
): Promise<{ url: string; target: BrowserTargetDevice | null }> {
  const normalized = normalizeBrowserUrl(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { url: normalized, target: requestedTarget };
  }

  const target = requestedTarget ?? defaultBrowserTarget();
  if (!target) return { url: normalized, target: null };
  const port = browserUrlPort(parsed);
  if (!port) return { url: normalized, target };

  const targetHostname = target.tailscaleDnsName?.toLowerCase() ?? null;
  const hostname = parsed.hostname.toLowerCase();
  const subdomain = deviceSubdomain(hostname, targetHostname);
  const targetsSelectedDevice = targetHostname !== null
    && (hostname === targetHostname || hostname.endsWith(`.${targetHostname}`));
  if (!isLoopbackBrowserHostname(hostname) && !targetsSelectedDevice) {
    return { url: normalized, target };
  }

  const result = await deviceSessions.ensureTailscalePort(target.deviceId, port);
  if (result.state !== 'ready' || !result.dnsName) {
    throw new Error(result.message ?? `Could not open port ${port} on ${target.name}.`);
  }

  if (subdomain) {
    if (!result.ipAddress || !isIpv4Address(result.ipAddress)) {
      throw new Error(
        `Could not route the ${subdomain} subdomain through ${target.name}: `
        + 'the Device did not report a Tailscale IPv4 address.'
      );
    }
    // MagicDNS publishes the Device hostname, not arbitrary children beneath it.
    // IP-backed wildcard DNS keeps the application's virtual-host prefix intact.
    parsed.hostname = `${subdomain}.${result.ipAddress}.nip.io`;
  } else {
    parsed.hostname = result.dnsName;
  }
  return {
    url: parsed.toString(),
    target: { ...target, tailscaleDnsName: result.dnsName }
  };
}

function deviceSubdomain(hostname: string, targetHostname: string | null): string | null {
  if (hostname.endsWith('.localhost')) {
    return hostname.slice(0, -'.localhost'.length) || null;
  }
  if (targetHostname && hostname.endsWith(`.${targetHostname}`)) {
    return hostname.slice(0, -(targetHostname.length + 1)) || null;
  }
  return null;
}

function isIpv4Address(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/u.test(octet)) return false;
    if (octet.length > 1 && octet.startsWith('0')) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
}

export async function openDeviceBrowserUrl(rawUrl: string, deviceId: DeviceId): Promise<void> {
  if (!deviceSessions.loaded) await deviceSessions.load();
  if (!connections.loaded) await connections.load();
  const target = browserTargetForDevice(deviceId);
  if (!target) throw new Error('The terminal Device is unavailable.');
  const tab = browserStore.addTab('about:blank', target);
  rightRail.openTab('browser');
  try {
    const resolved = await resolveDeviceBrowserUrl(rawUrl, target);
    if (resolved.target) browserStore.setTargetDevice(tab.id, resolved.target);
    browserStore.navigate(tab.id, resolved.url);
  } catch (error) {
    browserStore.closeTab(tab.id);
    throw error;
  }
}

export function tailscaleDnsNameForDevice(deviceId: DeviceId, local: boolean): string | null {
  if (local) return normalizeDnsName(connections.snapshot.tailscale.selfDnsName);
  const machine = connections.snapshot.machines.find((candidate) => candidate.deviceId === deviceId);
  if (!machine) return null;
  for (const endpoint of [machine.endpoint, ...machine.endpointAliases]) {
    if (!endpoint) continue;
    try {
      const hostname = endpoint.includes('://')
        ? new URL(endpoint).hostname
        : new URL(`https://${endpoint}`).hostname;
      const dnsName = normalizeDnsName(hostname);
      if (dnsName) return dnsName;
    } catch {
      // Try the next endpoint alias.
    }
  }
  return null;
}

function normalizeDnsName(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\.$/u, '').toLowerCase() ?? '';
  return normalized.endsWith('.ts.net') ? normalized : null;
}
