export interface SystemUsageSnapshot {
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
  electronProcessCount: number;
  childProcessCount: number;
  sampledAt: string;
}
