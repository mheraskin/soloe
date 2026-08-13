import type { CockpitDeviceSummary } from '@shared/types/cockpit.js';
import type { DeviceId } from '@shared/types/devices.js';

export type DevicePresentationTone = 'online' | 'offline' | 'connecting' | 'update';

export interface DevicePresentation {
  label: string;
  actionable: boolean;
  tone: DevicePresentationTone;
  dot: boolean;
}

export function devicePresentation(device: CockpitDeviceSummary): DevicePresentation {
  switch (device.state) {
    case 'ready':
      return {
        label: device.name,
        actionable: true,
        tone: 'online',
        dot: true
      };
    case 'incompatible':
      return unavailable(`${device.name} · Update Soloe`, 'update');
    case 'connecting':
      return unavailable(`${device.name} · Connecting`, 'connecting');
    case 'offline':
      return unavailable(`${device.name} · Offline`, 'offline');
    case 'degraded':
    case 'provisional':
      return unavailable(`${device.name} · Unavailable`, 'offline');
  }
}

export function sessionDevicePresentation(
  deviceId: DeviceId,
  devices: readonly CockpitDeviceSummary[]
): DevicePresentation {
  const device = devices.find((candidate) => candidate.deviceId === deviceId);
  return device
    ? devicePresentation(device)
    : unavailable('Unknown Device · Offline', 'offline');
}

function unavailable(
  label: string,
  tone: Exclude<DevicePresentationTone, 'online'>
): DevicePresentation {
  return { label, actionable: false, tone, dot: false };
}
