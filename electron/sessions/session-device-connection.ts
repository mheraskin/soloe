import type { DeviceId } from '../../shared/types/devices.js';
import type { MachineConnection } from '../../shared/types/connections.js';

export type SessionDeviceConnection = MachineConnection & {
  deviceId: DeviceId;
  endpoint: string;
};

export function isSessionDeviceConnection(
  machine: MachineConnection
): machine is SessionDeviceConnection {
  return machine.id !== 'local'
    && Boolean(machine.deviceId)
    && Boolean(machine.endpoint)
    && machine.enabled
    && machine.trust === 'pinned'
    && machine.compatibility?.status === 'compatible'
    && !machine.updateRequired;
}
