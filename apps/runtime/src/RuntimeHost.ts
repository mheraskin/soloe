import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type {
  RuntimeProcess,
  RuntimeProcessFactory,
  RuntimeTerminalStart,
  RuntimeTerminalState
} from './RuntimeProcess.js';
import { ProcessTreeUsageSampler } from "./ProcessTreeUsageSampler.js";
import { TerminalHistoryBuffer } from './TerminalHistoryBuffer.js';
import {
  TerminalInputLeaseError,
  TerminalInputLeaseManager
} from './TerminalInputLeaseManager.js';
import { TerminalLocationParser } from '../../../shared/terminal-location.js';
import type { TerminalControlProof } from '../../../shared/types/terminal.js';

export interface RuntimeHostOptions {
  endpoint: string;
  processFactory: RuntimeProcessFactory;
  usageSampler?: Pick<ProcessTreeUsageSampler, "sample">;
}

interface RunningTerminal {
  process: RuntimeProcess;
  state: RuntimeTerminalState;
  locationParser: TerminalLocationParser;
}

interface RuntimeRequest {
  id: number;
  method: string;
  params?: unknown;
}

export class RuntimeHost {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly socketOwners = new Map<Socket, Set<string>>();
  private readonly terminals = new Map<string, RunningTerminal>();
  private readonly terminalBySession = new Map<string, string>();
  private readonly outputSequence = new Map<string, number>();
  private readonly historyBuffer = new TerminalHistoryBuffer();
  private readonly usageSampler: Pick<ProcessTreeUsageSampler, "sample">;
  private readonly inputLeases: TerminalInputLeaseManager;

  constructor(private readonly options: RuntimeHostOptions) {
    this.usageSampler = options.usageSampler ?? new ProcessTreeUsageSampler();
    this.inputLeases = new TerminalInputLeaseManager({
      onChange: (event) => this.broadcast('inputLease', event)
    });
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.endpoint);
    });
  }

  async shutdown(): Promise<void> {
    for (const terminal of this.terminals.values()) {
      terminal.process.kill();
    }
    this.terminals.clear();
    this.terminalBySession.clear();
    this.outputSequence.clear();
    this.historyBuffer.clear();
    this.inputLeases.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    this.socketOwners.set(socket, new Set());
    let released = false;
    const releaseSocket = () => {
      if (released) return;
      released = true;
      this.sockets.delete(socket);
      for (const ownerId of this.socketOwners.get(socket) ?? []) {
        this.inputLeases.releaseTransportClient(ownerId);
      }
      this.socketOwners.delete(socket);
    };
    socket.once('end', releaseSocket);
    socket.once('close', releaseSocket);
    socket.once('error', releaseSocket);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('error', () => {
      releaseSocket();
      socket.destroy();
    });
    lines.on('line', (line) => {
      void this.handleLine(socket, line);
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: RuntimeRequest;
    try {
      request = JSON.parse(line) as RuntimeRequest;
      const value = await this.dispatch(socket, request.method, request.params);
      socket.write(`${JSON.stringify({ id: request.id, ok: true, value })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({
        id: (request! as RuntimeRequest | undefined)?.id ?? 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof TerminalInputLeaseError ? { code: error.code } : {})
      })}\n`);
    }
  }

  private async dispatch(socket: Socket, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'start':
        return this.start(params as RuntimeTerminalStart);
      case 'listRunning':
        return [...this.terminals.values()].map(({ state }) => state);
      case "usage":
        return this.usageSampler.sample();
      case 'historySnapshot': {
        const input = params as { terminalId: string };
        this.requireTerminal(input.terminalId);
        return this.historyBuffer.snapshot(input.terminalId);
      }
      case 'setHistoryUnbounded': {
        const input = params as { unbounded?: unknown };
        if (typeof input.unbounded !== 'boolean') {
          throw new Error('Invalid terminal history retention setting');
        }
        this.historyBuffer.setUnbounded(input.unbounded);
        return true;
      }
      case 'acquireInputLease': {
        const input = params as {
          terminalId: string;
          ownerId: string;
          takeover?: boolean;
          deviceId?: string;
          deviceName?: string;
          ownerDeviceId?: string;
        };
        const terminal = this.requireTerminal(input.terminalId);
        this.socketOwners.get(socket)?.add(input.ownerId);
        return this.inputLeases.acquire(input.terminalId, input.ownerId, {
          takeover: input.takeover === true,
          sessionId: terminal.state.sessionId,
          ownerDeviceId: input.ownerDeviceId,
          controllerDeviceId: input.deviceId,
          controllerDeviceName: input.deviceName,
          cols: terminal.state.cols,
          rows: terminal.state.rows
        });
      }
      case 'currentInputLease': {
        const input = params as { terminalId: string };
        this.requireTerminal(input.terminalId);
        return this.inputLeases.current(input.terminalId);
      }
      case 'releaseInputLease': {
        const input = params as { terminalId: string } & TerminalControlProof;
        return this.inputLeases.release(input.terminalId, runtimeControlProof(input));
      }
      case 'parkInputLease': {
        const input = params as { terminalId: string } & TerminalControlProof;
        return this.inputLeases.park(input.terminalId, runtimeControlProof(input));
      }
      case 'releaseInputLeases': {
        const input = params as { ownerId: string };
        return this.inputLeases.releaseTransportClient(input.ownerId);
      }
      case 'write': {
        const input = params as {
          terminalId: string;
          data: string;
          sessionId: string;
          ownerDeviceId: string;
          controllerDeviceId: string;
          leaseId: string;
        };
        const terminal = this.requireTerminal(input.terminalId);
        this.inputLeases.authorizeControl(
          input.terminalId,
          runtimeControlProof(input),
          'input'
        );
        terminal.process.write(input.data);
        return true;
      }
      case 'resize': {
        const input = params as {
          terminalId: string;
          cols: number;
          rows: number;
          sessionId: string;
          ownerDeviceId: string;
          controllerDeviceId: string;
          leaseId: string;
        };
        const terminal = this.requireTerminal(input.terminalId);
        const lease = this.inputLeases.resize(
          input.terminalId,
          runtimeControlProof(input),
          input.cols,
          input.rows
        );
        terminal.process.resize(input.cols, input.rows);
        terminal.state.cols = input.cols;
        terminal.state.rows = input.rows;
        this.historyBuffer.resize(input.terminalId, input.cols, input.rows);
        return lease;
      }
      case 'stop': {
        const input = params as { terminalId: string };
        const terminal = this.terminals.get(input.terminalId);
        if (!terminal) return true;
        await this.stopAndAwait(input.terminalId, terminal);
        return true;
      }
      default:
        throw new Error(`Unknown runtime method: ${method}`);
    }
  }

  private requireTerminal(terminalId: string): RunningTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Terminal not found: ${terminalId}`);
    return terminal;
  }

  private stopAndAwait(
    terminalId: string,
    terminal: RunningTerminal,
    timeoutMs = 2_000
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(failureTimer);
        terminal.process.off('exit', onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();
      const forceTimer = setTimeout(() => {
        try {
          terminal.process.kill('SIGKILL');
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }, timeoutMs);
      const failureTimer = setTimeout(() => {
        finish(new Error(`Terminal ${terminalId} did not exit after it was stopped`));
      }, timeoutMs * 2);
      forceTimer.unref();
      failureTimer.unref();
      terminal.process.once('exit', onExit);
      try {
        terminal.process.kill();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async start(input: RuntimeTerminalStart): Promise<RuntimeTerminalState> {
    if (this.terminalBySession.has(input.sessionId)) {
      throw new Error(`Session ${input.sessionId} is already running`);
    }
    const terminalId = input.terminalId ?? randomUUID();
    if (this.terminals.has(terminalId)) {
      throw new Error(`Terminal ${terminalId} is already running`);
    }
    const process = await this.options.processFactory.spawn({
      terminalId,
      sessionId: input.sessionId,
      spec: input.spec,
      cols: input.cols,
      rows: input.rows
    });
    const state: RuntimeTerminalState = {
      terminalId,
      sessionId: input.sessionId,
      pid: process.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd: input.spec.cwd,
      spec: input.spec,
      cols: input.cols,
      rows: input.rows
    };
    const terminal: RunningTerminal = {
      process,
      state,
      locationParser: new TerminalLocationParser(globalThis.process.platform === 'win32')
    };
    this.terminals.set(terminalId, terminal);
    this.terminalBySession.set(input.sessionId, terminalId);
    this.outputSequence.set(terminalId, 0);
    this.historyBuffer.register({
      terminalId,
      sessionId: input.sessionId,
      cols: input.cols,
      rows: input.rows
    });
    process.on('data', (data: string) => {
      for (const cwd of terminal.locationParser.push(data)) {
        if (cwd === state.cwd) continue;
        state.cwd = cwd;
        this.broadcast('location', {
          terminalId,
          sessionId: input.sessionId,
          cwd
        });
      }
      const seq = (this.outputSequence.get(terminalId) ?? 0) + 1;
      this.outputSequence.set(terminalId, seq);
      const event = {
        terminalId,
        sessionId: input.sessionId,
        data,
        seq
      };
      this.historyBuffer.append(event);
      this.broadcast('output', event);
    });
    process.once('exit', (event: { exitCode?: number | null; signal?: number | null } = {}) => {
      this.terminals.delete(terminalId);
      this.terminalBySession.delete(input.sessionId);
      this.outputSequence.delete(terminalId);
      this.inputLeases.clearTerminal(terminalId);
      this.broadcast('exit', {
        terminalId,
        sessionId: input.sessionId,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null
      });
    });
    return state;
  }

  private broadcast(event: string, payload: unknown): void {
    const line = `${JSON.stringify({ event, payload })}\n`;
    for (const socket of this.sockets) {
      if (socket.writable) socket.write(line);
    }
  }
}

function runtimeControlProof(input: TerminalControlProof): TerminalControlProof {
  return {
    sessionId: input.sessionId,
    ownerDeviceId: input.ownerDeviceId,
    controllerDeviceId: input.controllerDeviceId,
    leaseId: input.leaseId
  };
}
