import type { CockpitDeviceSummary } from '@shared/types/cockpit.js';
import type { MachineConnection } from '@shared/types/connections.js';
import type { DeviceId } from '@shared/types/devices.js';

export type DevicePresentationTone = 'online' | 'offline' | 'connecting' | 'update';

export interface DevicePresentation {
  label: string;
  actionable: boolean;
  tone: DevicePresentationTone;
  dot: boolean;
}

export interface DeviceSummaryPresentation extends CockpitDeviceSummary {
  isLocal: boolean;
}

export interface ConnectionDevicePresentation {
  name: string;
  status: 'Online' | 'Offline' | 'Update Soloe';
  tone: 'online' | 'offline' | 'update';
  isLocal: boolean;
}

export interface DeviceFilterPresentation {
  showAggregate: boolean;
  selectedDeviceId: DeviceId | null;
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

export function reconcileDeviceSummaries(
  devices: readonly CockpitDeviceSummary[],
  machines: readonly MachineConnection[]
): DeviceSummaryPresentation[] {
  const localDeviceIds = new Set(
    machines
      .filter(isLocalMachine)
      .flatMap((machine) => machine.deviceId ? [machine.deviceId] : [])
  );
  const summaries = new Map<DeviceId, DeviceSummaryPresentation>(
    devices.map((device) => [device.deviceId, {
      ...device,
      isLocal: localDeviceIds.has(device.deviceId)
    }])
  );

  for (const machine of machines) {
    if (!machine.deviceId) continue;
    const existing = summaries.get(machine.deviceId);
    const isLocal = isLocalMachine(machine);
    const state = isLocal && machine.status === 'available'
      ? 'ready'
      : machine.updateRequired
          || (machine.compatibility && machine.compatibility.status !== 'compatible')
        ? 'incompatible'
        : machine.status === 'unavailable' || machine.trust === 'identity-mismatch'
          ? 'offline'
          : existing?.state ?? 'connecting';
    summaries.set(machine.deviceId, {
      ...(existing ?? {
        deviceId: machine.deviceId,
        name: machine.name
      }),
      name: machine.name,
      state,
      isLocal
    });
  }

  return [...summaries.values()].sort((left, right) => {
    if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export function connectionDevicePresentation(
  machine: MachineConnection
): ConnectionDevicePresentation {
  const isLocal = isLocalMachine(machine);
  if (isLocal && machine.status === 'available') {
    return { name: machine.name, status: 'Online', tone: 'online', isLocal };
  }
  if (
    (!isLocal && !machine.deviceId)
    || machine.updateRequired
    || (machine.compatibility && machine.compatibility.status !== 'compatible')
  ) {
    return { name: machine.name, status: 'Update Soloe', tone: 'update', isLocal };
  }
  if (
    machine.status === 'available'
    && (machine.trust === 'local' || machine.trust === 'pinned')
  ) {
    return { name: machine.name, status: 'Online', tone: 'online', isLocal };
  }
  return { name: machine.name, status: 'Offline', tone: 'offline', isLocal };
}

export function connectionDevices(
  machines: readonly MachineConnection[]
): MachineConnection[] {
  return machines
    .filter((machine) => isLocalMachine(machine) || machine.source === 'discovered')
    .sort((left, right) => {
      const leftLocal = isLocalMachine(left);
      const rightLocal = isLocalMachine(right);
      if (leftLocal !== rightLocal) return leftLocal ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

export function deviceFilterPresentation(
  devices: readonly DeviceSummaryPresentation[],
  filterDeviceIds: readonly DeviceId[]
): DeviceFilterPresentation {
  if (devices.length === 1 && filterDeviceIds.length === 0) {
    return {
      showAggregate: false,
      selectedDeviceId: devices[0]!.deviceId
    };
  }
  return {
    showAggregate: devices.length > 1,
    selectedDeviceId: filterDeviceIds.length === 1 ? filterDeviceIds[0]! : null
  };
}

function unavailable(
  label: string,
  tone: Exclude<DevicePresentationTone, 'online'>
): DevicePresentation {
  return { label, actionable: false, tone, dot: false };
}

function isLocalMachine(machine: MachineConnection): boolean {
  return machine.id === 'local' || machine.source === 'local' || machine.isSelf;
}
