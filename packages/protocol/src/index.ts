export interface RuntimeSpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  description?: string;
}

export interface RuntimeTerminalStart {
  terminalId?: string;
  sessionId: string;
  spec: RuntimeSpawnSpec;
  cols: number;
  rows: number;
}

export interface RuntimeTerminalState {
  terminalId: string;
  sessionId: string;
  pid: number;
  status: "running";
  startedAt: string;
  /** Current Terminal directory, distinct from the Worktree in `spec.cwd`. */
  cwd?: string;
  spec: RuntimeSpawnSpec;
  cols: number;
  rows: number;
}

export interface RuntimeOutputEvent {
  terminalId: string;
  sessionId: string;
  data: string;
  seq: number;
}

export interface RuntimeExitEvent {
  terminalId: string;
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
}

export interface RuntimeLocationEvent {
  terminalId: string;
  sessionId: string;
  cwd: string;
}

export interface RuntimeHistorySnapshot {
  kind: 'ghostty-vt-history-v1';
  terminalId: string;
  sessionId: string;
  cols: number;
  rows: number;
  data: string;
  fromSeq: number;
  toSeq: number;
  truncated: boolean;
  byteLength: number;
}

export type RuntimeUsageAvailability =
  | "available"
  | "degraded"
  | "unavailable";

export interface RuntimeProcessUsageComponent {
  kind: "runtime" | "agent-pty";
  availability: RuntimeUsageAvailability;
  cpuPercent: number | null;
  memoryBytes: number | null;
  processCount: number | null;
  message?: string;
}

export interface RuntimeUsageSnapshot {
  availability: RuntimeUsageAvailability;
  cpuPercent: number | null;
  memoryBytes: number | null;
  processCount: number | null;
  components: RuntimeProcessUsageComponent[];
  sampledAt: string;
  message?: string;
}
