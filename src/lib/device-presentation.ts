import type { MachineConnection } from '@shared/types/connections.js';

export interface ConnectionDevicePresentation {
  name: string;
  status: 'Online' | 'Offline' | 'Update Soloe';
  tone: 'online' | 'offline' | 'update';
  isLocal: boolean;
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

export function connectionDiscoverySummary(
  machines: readonly MachineConnection[]
): string {
  const remoteDevices = connectionDevices(machines)
    .filter((machine) => !isLocalMachine(machine))
    .map(connectionDevicePresentation);
  if (remoteDevices.length === 0) return 'No other Soloe devices found';

  const online = remoteDevices.filter((device) => device.tone === 'online').length;
  const updates = remoteDevices.filter((device) => device.tone === 'update').length;
  const offline = remoteDevices.length - online - updates;
  const found = `${remoteDevices.length} other Soloe ${
    remoteDevices.length === 1 ? 'device' : 'devices'
  } found`;
  if (remoteDevices.length === 1) {
    if (online === 1) return `${found} · online`;
    if (updates === 1) return `${found} · needs an update`;
    return `${found} · offline`;
  }

  const states: string[] = [];
  if (online > 0) states.push(`${online} online`);
  if (updates > 0) states.push(`${updates} ${updates === 1 ? 'needs' : 'need'} an update`);
  if (offline > 0) states.push(`${offline} offline`);
  return `${found} · ${states.join(' · ')}`;
}

function isLocalMachine(machine: MachineConnection): boolean {
  return machine.id === 'local' || machine.source === 'local' || machine.isSelf;
}
