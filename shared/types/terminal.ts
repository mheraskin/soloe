import type { SessionId, SessionStatus } from './sessions.js';

export type TerminalId = string;

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalControllerIdentity {
  deviceId: string;
  deviceName: string;
}

export interface TerminalControlProof {
  sessionId: SessionId;
  ownerDeviceId: string;
  controllerDeviceId: string;
  leaseId: string;
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

export interface TerminalHistoryResize {
  offset: number;
  cols: number;
  rows: number;
}

export interface TerminalHistoryReplayPlan extends TerminalDimensions {
  resizes: TerminalHistoryResize[];
}

/** Renderer-neutral VT history reconstructed by Ghostty in each web surface. */
export interface TerminalHistorySnapshot {
  kind: 'ghostty-vt-history-v1';
  terminalId: TerminalId;
  sessionId: SessionId;
  cols: number;
  rows: number;
  data: string;
  fromSeq: number;
  toSeq: number;
  truncated: boolean;
  byteLength: number;
  /** Dimensions active while each retained VT segment was originally emitted. */
  replay?: TerminalHistoryReplayPlan;
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
  sessionId: SessionId;
  ownerDeviceId: string;
  leaseId: string;
  controllerDeviceId: string;
  controllerDeviceName: string;
  generation: number;
  cols: number;
  rows: number;
  acquiredAt: string;
}

export type TerminalControlLease = TerminalInputLease;

export function terminalControlProof(lease: TerminalInputLease): TerminalControlProof {
  return {
    sessionId: lease.sessionId,
    ownerDeviceId: lease.ownerDeviceId,
    controllerDeviceId: lease.controllerDeviceId,
    leaseId: lease.leaseId
  };
}

export interface TerminalInputLeaseEvent {
  type: 'acquired' | 'released' | 'taken-over' | 'resized';
  terminalId: TerminalId;
  lease: TerminalInputLease | null;
  generation?: number;
  previousControllerDeviceId?: string;
  observedAt: string;
}

export type TerminalControlLeaseEvent = TerminalInputLeaseEvent;

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
export const OUTPUT_BATCH_INTERVAL_MS = 16;
