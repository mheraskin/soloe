export const TERMINAL_SIDECAR_PROTOCOL_VERSION = 1;
export const TERMINAL_SIDECAR_MAX_LINE_BYTES = 1024 * 1024;

export interface TerminalSidecarRequest {
  id: number;
  method: string;
  params?: unknown;
}

export type TerminalSidecarResponse<T = unknown> =
  | { id: number; ok: true; value: T }
  | { id: number; ok: false; error: string };

export interface TerminalSidecarStartRequest {
  terminalId: string;
  sessionId: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface TerminalSidecarStartResponse {
  terminalId: string;
  sessionId: string;
  pid: number;
}

export type TerminalSidecarEvent =
  | {
      event: 'output';
      payload: {
        terminalId: string;
        sessionId: string;
        dataBase64: string;
        seq: number;
      };
    }
  | {
      event: 'exit';
      payload: {
        terminalId: string;
        sessionId: string;
        exitCode: number;
        signalName: string | null;
      };
    };

export interface TerminalSidecarPingResponse {
  protocolVersion: number;
}
