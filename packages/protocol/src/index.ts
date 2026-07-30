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

export interface RuntimeReplaySnapshot {
  terminalId: string;
  sessionId: string;
  data: string;
  fromSeq: number;
  toSeq: number;
  truncated: boolean;
  byteLength: number;
}
