export type ConnectionId = 'local' | `tailscale:${string}`;

export type MachineConnectionSource = 'local' | 'discovered' | 'manual';
export type MachineConnectionStatus = 'available' | 'unavailable' | 'unknown';

export interface MachineConnection {
  id: ConnectionId;
  name: string;
  endpoint: string | null;
  source: MachineConnectionSource;
  status: MachineConnectionStatus;
  active: boolean;
  isSelf: boolean;
  os?: string;
  lastSeenAt?: string;
}

export type TailscaleConnectionState =
  | 'connected'
  | 'not-running'
  | 'unavailable'
  | 'error';

export interface TailscaleConnectionInfo {
  state: TailscaleConnectionState;
  tailnet: string | null;
  selfDnsName: string | null;
  message: string | null;
}

export interface ConnectionSnapshot {
  activeId: ConnectionId;
  machines: MachineConnection[];
  tailscale: TailscaleConnectionInfo;
  refreshedAt: string | null;
}

export interface AddMachineConnectionRequest {
  endpoint: string;
}

export interface ConnectionSelectionResult {
  activeId: ConnectionId;
  relaunching: boolean;
}
