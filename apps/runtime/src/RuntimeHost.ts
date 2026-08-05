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
import { TerminalReplayBuffer } from './TerminalReplayBuffer.js';
import { TerminalLocationParser } from '../../../shared/terminal-location.js';

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
  private readonly terminals = new Map<string, RunningTerminal>();
  private readonly terminalBySession = new Map<string, string>();
  private readonly outputSequence = new Map<string, number>();
  private readonly replayBuffer = new TerminalReplayBuffer();
  private readonly usageSampler: Pick<ProcessTreeUsageSampler, "sample">;

  constructor(private readonly options: RuntimeHostOptions) {
    this.usageSampler = options.usageSampler ?? new ProcessTreeUsageSampler();
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
    this.replayBuffer.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      void this.handleLine(socket, line);
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: RuntimeRequest;
    try {
      request = JSON.parse(line) as RuntimeRequest;
      const value = await this.dispatch(request.method, request.params);
      socket.write(`${JSON.stringify({ id: request.id, ok: true, value })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({
        id: (request! as RuntimeRequest | undefined)?.id ?? 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })}\n`);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'start':
        return this.start(params as RuntimeTerminalStart);
      case 'listRunning':
        return [...this.terminals.values()].map(({ state }) => state);
      case "usage":
        return this.usageSampler.sample();
      case 'replay': {
        const input = params as { terminalId: string; afterSeq?: number };
        return this.replayBuffer.snapshot(input.terminalId, input.afterSeq);
      }
      case 'setReplayUnbounded': {
        const input = params as { unbounded?: unknown };
        if (typeof input.unbounded !== 'boolean') {
          throw new Error('Invalid replay retention setting');
        }
        this.replayBuffer.setUnbounded(input.unbounded);
        return true;
      }
      case 'write': {
        const input = params as { terminalId: string; data: string };
        const terminal = this.terminals.get(input.terminalId);
        if (!terminal) throw new Error(`Terminal not found: ${input.terminalId}`);
        terminal.process.write(input.data);
        return true;
      }
      case 'resize': {
        const input = params as { terminalId: string; cols: number; rows: number };
        const terminal = this.terminals.get(input.terminalId);
        if (!terminal) throw new Error(`Terminal not found: ${input.terminalId}`);
        terminal.process.resize(input.cols, input.rows);
        terminal.state.cols = input.cols;
        terminal.state.rows = input.rows;
        return true;
      }
      case 'stop': {
        const input = params as { terminalId: string };
        const terminal = this.terminals.get(input.terminalId);
        if (!terminal) return true;
        terminal.process.kill();
        return true;
      }
      default:
        throw new Error(`Unknown runtime method: ${method}`);
    }
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
      this.replayBuffer.append(event);
      this.broadcast('output', event);
    });
    process.once('exit', (event: { exitCode?: number | null; signal?: number | null } = {}) => {
      this.terminals.delete(terminalId);
      this.terminalBySession.delete(input.sessionId);
      this.outputSequence.delete(terminalId);
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
