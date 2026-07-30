import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type {
  RuntimeTerminalStart,
  RuntimeTerminalState
} from './RuntimeProcess.js';
import type { TerminalReplaySnapshot } from './TerminalReplayBuffer.js';

interface RuntimeResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class RuntimeClient extends EventEmitter {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor(private readonly socket: Socket) {
    super();
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => this.receive(line));
    socket.once('close', () => {
      const error = new Error('Environment Runtime connection closed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async connect(endpoint: string): Promise<RuntimeClient> {
    const socket = connect(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new RuntimeClient(socket);
  }

  start(input: RuntimeTerminalStart): Promise<RuntimeTerminalState> {
    return this.request('start', input);
  }

  listRunning(): Promise<RuntimeTerminalState[]> {
    return this.request('listRunning');
  }

  replay(terminalId: string, afterSeq = 0): Promise<TerminalReplaySnapshot | null> {
    return this.request('replay', { terminalId, afterSeq });
  }

  write(terminalId: string, data: string): Promise<true> {
    return this.request('write', { terminalId, data });
  }

  resize(terminalId: string, cols: number, rows: number): Promise<true> {
    return this.request('resize', { terminalId, cols, rows });
  }

  stop(terminalId: string): Promise<true> {
    return this.request('stop', { terminalId });
  }

  disconnect(): void {
    this.socket.end();
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private receive(line: string): void {
    let message: RuntimeResponse | { event: string; payload: unknown };
    try {
      message = JSON.parse(line) as RuntimeResponse | { event: string; payload: unknown };
    } catch {
      return;
    }
    if ('event' in message) {
      this.emit(message.event, message.payload);
      return;
    }
    const response = message;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(response.error ?? 'Environment Runtime request failed'));
  }
}
