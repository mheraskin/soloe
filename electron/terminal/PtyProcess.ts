import type { SessionId } from '@shared/types/sessions.js';
import type {
  SpawnSpec,
  TerminalHistorySnapshot,
  TerminalId
} from '@shared/types/terminal.js';
import type { RuntimeTerminalState } from '@soloe/protocol';

export interface PtyProcessDisposable {
  dispose(): void;
}

export interface PtyProcessExit {
  exitCode: number;
  signal?: number;
}

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string, seq?: number) => void): PtyProcessDisposable;
  onExit(listener: (event: PtyProcessExit) => void): PtyProcessDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyProcessSpawnOptions {
  terminalId: TerminalId;
  sessionId: SessionId;
  spec: SpawnSpec;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface PtyHistoryProvider {
  snapshot(terminalId: TerminalId): Promise<TerminalHistorySnapshot | null>;
  setLineLimit(lineLimit: number): Promise<unknown> | unknown;
}

/**
 * Physical PTY seam. The Node and Rust Adapters both satisfy this Interface;
 * the optional history capability selects Runtime replay instead of a local
 * fallback without creating two authorities for one process.
 */
export interface PtyProcessFactory {
  readonly outputIsPrebatched?: boolean;
  readonly preservesProcessesOnDispose?: boolean;
  readonly history?: PtyHistoryProvider;
  spawn(options: PtyProcessSpawnOptions): Promise<PtyProcess> | PtyProcess;
  listRunning?(): Promise<RuntimeTerminalState[]>;
  attach?(terminal: RuntimeTerminalState): PtyProcess;
  dispose?(): Promise<void> | void;
}
