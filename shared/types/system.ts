export type SystemUsageDetail = 'summary' | 'wsl';

export interface SystemUsageRequest {
  detail?: SystemUsageDetail;
}

export interface SystemUsageSnapshot {
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
  electronProcessCount: number;
  childProcessCount: number;
  wslActive: boolean;
  wsl: WslUsageSnapshot | null;
  sampledAt: string;
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
