import type { EventEmitter } from 'node:events';
import type {
  RuntimeSpawnSpec,
  RuntimeTerminalStart,
  RuntimeTerminalState
} from '@soloe/protocol';

export type { RuntimeSpawnSpec, RuntimeTerminalStart, RuntimeTerminalState };

export interface RuntimeProcess extends EventEmitter {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface RuntimeProcessFactory {
  spawn(options: {
    terminalId: string;
    sessionId: string;
    spec: RuntimeSpawnSpec;
    cols: number;
    rows: number;
  }): RuntimeProcess | Promise<RuntimeProcess>;
}
