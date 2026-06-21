import type { RunMode } from './sessions.js';

// One filesystem-existence probe. WSL paths are checked inside the distro so a
// stopped/unreachable distro can't be mistaken for a deleted folder.
export interface PathExistsRequest {
  path: string;
  runMode: RunMode;
  wslDistro?: string;
}

export interface SystemUsageSnapshot {
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
  electronProcessCount: number;
  childProcessCount: number;
  sampledAt: string;
}
