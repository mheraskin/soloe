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
  if (!deviceSessions.multiDeviceActive) return [];
  return deviceSessions.visibleDevices.map((device) => ({
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
  if (!deviceSessions.multiDeviceActive) return null;
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
    return {
      url: normalized,
      target: deviceSessions.multiDeviceActive ? requestedTarget : null
    };
  }

  if (!deviceSessions.multiDeviceActive) return { url: normalized, target: null };

  const target = requestedTarget ?? defaultBrowserTarget();
  if (!target) return { url: normalized, target: null };
  const port = browserUrlPort(parsed);
  if (!port) return { url: normalized, target };

  const targetHostname = target.tailscaleDnsName?.toLowerCase() ?? null;
  const shortTargetHostname = shortDeviceHostname(targetHostname, target.name);
  if (!shortTargetHostname) return { url: normalized, target };
  const hostname = parsed.hostname.toLowerCase();
  const subdomain = deviceSubdomain(hostname, targetHostname, shortTargetHostname);
  const targetsSelectedDevice = targetHostname !== null
    && (
      hostname === targetHostname
      || hostname.endsWith(`.${targetHostname}`)
      || hostname === shortTargetHostname
      || hostname.endsWith(`.${shortTargetHostname}`)
    );
  if (!isLoopbackBrowserHostname(hostname) && !targetsSelectedDevice) {
    return { url: normalized, target };
  }

  const virtualHostname = subdomain
    ? `${subdomain}.${shortTargetHostname}`
    : shortTargetHostname;
  const result = await deviceSessions.ensureTailscalePort(
    target.deviceId,
    port,
    virtualHostname
  );
  if (result.state !== 'ready' || !result.dnsName) {
    throw new Error(result.message ?? `Could not open port ${port} on ${target.name}.`);
  }

  if (result.virtualHostname && result.targetPort === port) {
    if (result.port === port) {
      parsed.hostname = connections.snapshot.shortDns.readyZones.includes(shortTargetHostname)
        ? virtualHostname
        : fallbackHostname(virtualHostname, result.ipAddress, result.dnsName);
      parsed.port = String(port);
    } else {
      // Compatibility with Devices that expose the private route port.
      parsed.hostname = result.dnsName;
      parsed.port = String(result.port);
    }
  } else if (subdomain) {
    if (!result.virtualHostname || result.targetPort !== port) {
      throw new Error(
        `Could not route the ${subdomain} subdomain through ${target.name}: `
        + 'the Device does not support virtual-host browser routes.'
      );
    }
  } else {
    parsed.hostname = result.dnsName;
  }
  return {
    url: parsed.toString(),
    target: { ...target, tailscaleDnsName: result.dnsName }
  };
}

function fallbackHostname(
  virtualHostname: string,
  ipAddress: string | null | undefined,
  magicDnsName: string
): string {
  if (!virtualHostname.includes('.')) return magicDnsName;
  const encodedIp = ipAddress?.replaceAll('.', '-');
  if (encodedIp && /^100-(?:\d{1,3}-){2}\d{1,3}$/u.test(encodedIp)) {
    return `${virtualHostname}.${encodedIp}.nip.io`;
  }
  throw new Error(
    `Short subdomain URLs are not configured on this Device. Set them up in Settings → Connections.`
  );
}

function deviceSubdomain(
  hostname: string,
  targetHostname: string | null,
  shortTargetHostname: string
): string | null {
  if (hostname.endsWith('.localhost')) {
    return hostname.slice(0, -'.localhost'.length) || null;
  }
  if (targetHostname && hostname.endsWith(`.${targetHostname}`)) {
    return hostname.slice(0, -(targetHostname.length + 1)) || null;
  }
  if (hostname.endsWith(`.${shortTargetHostname}`)) {
    return hostname.slice(0, -(shortTargetHostname.length + 1)) || null;
  }
  return null;
}

function shortDeviceHostname(targetHostname: string | null, deviceName: string): string | null {
  const magicDnsLabel = targetHostname?.split('.')[0] ?? '';
  if (isDnsLabel(magicDnsLabel)) return magicDnsLabel;
  const nameLabel = deviceName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
  return isDnsLabel(nameLabel) ? nameLabel : null;
}

function isDnsLabel(value: string): boolean {
  return value.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value);
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
    browserStore.setTargetDevice(tab.id, resolved.target);
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
