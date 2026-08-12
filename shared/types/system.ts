import type { RunMode } from './sessions.js';

export type HostPlatform = 'windows' | 'linux' | 'macos';

export interface HostPlatformInfo {
  platform: HostPlatform;
  defaultRunMode: Exclude<RunMode, 'wsl'>;
  availableRunModes: RunMode[];
  supportsWsl: boolean;
}

export type SystemUsageDetail = 'summary' | 'wsl';

export interface SystemUsageRequest {
  detail?: SystemUsageDetail;
}

export type SystemUsageScope = 'backend' | 'client';
export type SystemUsageAvailability = 'available' | 'degraded' | 'unavailable';
export type SystemUsageComponentKind =
  | 'application-server'
  | 'runtime'
  | 'agent-worker'
  | 'agent-pty'
  | 'wsl-supervisor'
  | 'electron'
  | 'client-child';

export interface SystemUsageComponent {
  kind: SystemUsageComponentKind;
  availability: SystemUsageAvailability;
  cpuPercent: number | null;
  memoryBytes: number | null;
  processCount: number | null;
  message?: string;
}

export interface SystemUsageSnapshot {
  scope: SystemUsageScope;
  availability: SystemUsageAvailability;
  backendPlacement: 'native' | 'wsl' | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  processCount: number | null;
  electronProcessCount: number | null;
  childProcessCount: number | null;
  components: SystemUsageComponent[];
  wslActive: boolean;
  wsl: WslUsageSnapshot | null;
  sampledAt: string;
  message?: string;
}

export interface WslUsageSnapshot {
  // These figures cover the whole WSL 2 utility VM, including work outside Soloe.
  // Null for the first sample because CPU is calculated from counter deltas.
  cpuPercent: number | null;
  memoryBytes: number;
  memoryTotalBytes: number;
  distroCount: number;
  sampledAt: string;
}
