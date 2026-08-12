import type { SessionId, SessionStatus } from './sessions.js';

export type TerminalId = string;

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  description: string;
}

export interface TerminalOutputEvent {
  terminalId: TerminalId;
  sessionId: SessionId;
  data: string;
  seq: number;
}

export interface TerminalReplaySnapshot {
  terminalId: TerminalId;
  sessionId: SessionId;
  data: string;
  fromSeq: number;
  toSeq: number;
  truncated: boolean;
  byteLength: number;
}

export interface TerminalExitEvent {
  terminalId: TerminalId;
  sessionId: SessionId;
  exitCode: number | null;
  signal: number | null;
}

export interface TerminalStatusEvent {
  sessionId: SessionId;
  terminalId: TerminalId | null;
  status: SessionStatus;
  message?: string;
}

export interface TerminalLocationEvent {
  terminalId: TerminalId;
  sessionId: SessionId;
  cwd: string;
}

export interface TerminalStartResult {
  terminalId: TerminalId;
  sessionId: SessionId;
  pid: number;
  spec: SpawnSpec;
}

export interface TerminalStartOptions {
  sessionId: SessionId;
  cols?: number;
  rows?: number;
}

export interface TerminalInputLease {
  terminalId: TerminalId;
  leaseId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface TerminalInputLeaseEvent {
  type: 'acquired' | 'renewed' | 'released' | 'expired' | 'taken-over';
  terminalId: TerminalId;
  lease: TerminalInputLease | null;
  previousOwnerId?: string;
  observedAt: string;
}

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
export const OUTPUT_BATCH_INTERVAL_MS = 16;
