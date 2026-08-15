import type {
  DeviceId,
  DeviceProtocolCompatibility,
  DeviceProtocolRange
} from './devices.js';

export type ConnectionId = 'local' | `tailscale:${string}` | `device:${DeviceId}`;

export type MachineConnectionSource = 'local' | 'discovered' | 'manual';
export type MachineConnectionStatus = 'available' | 'unavailable' | 'unknown';
export type MachineConnectionTrust =
  | 'local'
  | 'provisional'
  | 'pinned'
  | 'identity-mismatch';

export interface MachineConnection {
  id: ConnectionId;
  name: string;
  endpoint: string | null;
  endpointAliases: string[];
  source: MachineConnectionSource;
  status: MachineConnectionStatus;
  trust: MachineConnectionTrust;
  enabled: boolean;
  active: boolean;
  isSelf: boolean;
  deviceId?: DeviceId;
  observedDeviceId?: DeviceId;
  os?: string;
  protocol?: DeviceProtocolRange;
  compatibility?: DeviceProtocolCompatibility;
  capabilityRevision?: string;
  capabilities?: string[];
  serverEpoch?: string;
  lastSeenAt?: string;
  updateRequired?: boolean;
}

export type TailscaleConnectionState =
  | 'disabled'
  | 'connected'
  | 'not-running'
  | 'unavailable'
  | 'error';

export type TailscaleSharingState =
  | 'ready'
  | 'unavailable'
  | 'not-running'
  | 'setup-required'
  | 'conflict'
  | 'error';

export interface TailscaleSharingInfo {
  state: TailscaleSharingState;
  message: string | null;
  setupUrl: string | null;
}

export interface TailscaleConnectionInfo {
  state: TailscaleConnectionState;
  tailnet: string | null;
  selfDnsName: string | null;
  message: string | null;
  sharing: TailscaleSharingInfo;
}

export interface ConnectionSnapshot {
  activeId: ConnectionId;
  machines: MachineConnection[];
  preferences: ConnectionPreferences;
  tailscale: TailscaleConnectionInfo;
  refreshedAt: string | null;
}

export interface ConnectionPreferences {
  tailscaleEnabled: boolean;
  tailscaleHttpsPort: number;
}

export type ConnectionPreferencesUpdate = Partial<ConnectionPreferences>;

export interface AddMachineConnectionRequest {
  endpoint: string;
}

export interface ConnectionSelectionResult {
  activeId: ConnectionId;
  relaunching: boolean;
}
