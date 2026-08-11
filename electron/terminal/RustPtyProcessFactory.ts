import { EventEmitter, once } from 'node:events';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import type {
  TerminalSidecarEvent,
  TerminalSidecarPingResponse,
  TerminalSidecarRequest,
  TerminalSidecarResponse,
  TerminalSidecarStartResponse
} from '@shared/types/terminal-sidecar.js';
import {
  TERMINAL_SIDECAR_MAX_LINE_BYTES,
  TERMINAL_SIDECAR_PROTOCOL_VERSION
} from '@shared/types/terminal-sidecar.js';
import type {
  PtyProcess,
  PtyProcessDisposable,
  PtyProcessExit,
  PtyProcessFactory,
  PtyProcessSpawnOptions
} from './PtyProcess.js';

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export type SidecarSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams;

export interface RustPtyProcessFactoryOptions {
  executablePath: string;
  spawn?: SidecarSpawn;
  log?: (message: string, detail?: unknown) => void;
}

export class RustPtyProcessFactory implements PtyProcessFactory {
  readonly outputIsPrebatched = true;
  private readonly spawnSidecar: SidecarSpawn;
  private readonly log: (message: string, detail?: unknown) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private starting: Promise<void> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private processes = new Map<string, RustPtyProcess>();
  private disposing = false;

  constructor(private readonly options: RustPtyProcessFactoryOptions) {
    this.spawnSidecar = options.spawn ?? (spawn as SidecarSpawn);
    this.log = options.log ?? ((message, detail) => console.warn(message, detail));
  }

  async spawn(options: PtyProcessSpawnOptions): Promise<PtyProcess> {
    await this.ensureStarted();
    if (this.processes.has(options.terminalId)) {
      throw new Error(`Rust PTY already exists: ${options.terminalId}`);
    }
    const process = new RustPtyProcess(this, options.terminalId);
    this.processes.set(options.terminalId, process);
    try {
      const started = await this.request<TerminalSidecarStartResponse>('start', {
        terminalId: options.terminalId,
        sessionId: options.sessionId,
        file: options.spec.file,
        args: options.spec.args,
        cwd: options.spec.cwd,
        env: options.env,
        cols: options.cols,
        rows: options.rows
      });
      if (
        started.terminalId !== options.terminalId
        || started.sessionId !== options.sessionId
        || !Number.isSafeInteger(started.pid)
        || started.pid <= 0
      ) {
        throw new Error('Rust sidecar returned an invalid start response');
      }
      process.setPid(started.pid);
      return process;
    } catch (error) {
      this.processes.delete(options.terminalId);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const child = this.child;
    if (!child) return;
    try {
      await this.request('shutdown', {});
      await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 3_000))
      ]);
    } catch (error) {
      this.log('[rust-pty] graceful sidecar shutdown failed', error);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      this.lines?.close();
      this.lines = null;
      this.child = null;
      this.rejectPending(new Error('Rust terminal sidecar disposed'));
    }
  }

  write(terminalId: string, data: string): void {
    this.background('input', {
      terminalId,
      dataBase64: Buffer.from(data, 'utf8').toString('base64')
    });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.background('resize', { terminalId, cols, rows });
  }

  stop(terminalId: string): void {
    this.background('stop', { terminalId });
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    if (this.disposing) throw new Error('Rust terminal sidecar is disposed');
    if (!this.starting) {
      this.starting = this.startSidecar().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async startSidecar(): Promise<void> {
    const child = this.spawnSidecar(this.options.executablePath, [], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => this.onLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (detail: string) => {
      const message = detail.trim();
      if (message) this.log('[rust-pty] sidecar stderr', message);
    });
    child.once('error', (error) => this.onSidecarExit(error));
    child.once('exit', (code, signal) => {
      this.onSidecarExit(new Error(`Rust terminal sidecar exited (${code ?? signal ?? 'unknown'})`));
    });

    const ping = await this.sendRequest<TerminalSidecarPingResponse>('ping', {});
    if (ping.protocolVersion !== TERMINAL_SIDECAR_PROTOCOL_VERSION) {
      child.kill('SIGKILL');
      throw new Error(
        `Rust terminal protocol mismatch: expected ${TERMINAL_SIDECAR_PROTOCOL_VERSION}, received ${ping.protocolVersion}`
      );
    }
  }

  private async request<T = true>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params);
  }

  private sendRequest<T>(method: string, params: unknown): Promise<T> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('Rust terminal sidecar is not writable'));
    }
    const id = this.nextRequestId++;
    const request: TerminalSidecarRequest = { id, method, params };
    const line = `${JSON.stringify(request)}\n`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      child.stdin.write(line, 'utf8', (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private background(method: string, params: unknown): void {
    void this.request(method, params).catch((error) => {
      this.log(`[rust-pty] ${method} failed`, error);
    });
  }

  private onLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > TERMINAL_SIDECAR_MAX_LINE_BYTES) {
      this.onSidecarExit(new Error('Rust terminal sidecar emitted an oversized line'));
      this.child?.kill('SIGKILL');
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      this.failProtocol(`Rust terminal sidecar emitted invalid JSON: ${String(error)}`);
      return;
    }
    if (!isRecord(message)) {
      this.failProtocol('Rust terminal sidecar emitted a non-object message');
      return;
    }
    if ('id' in message) {
      if (!isTerminalSidecarResponse(message)) {
        this.failProtocol('Rust terminal sidecar emitted an invalid response');
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error));
      return;
    }
    if (!isTerminalSidecarEvent(message)) {
      this.failProtocol('Rust terminal sidecar emitted an invalid event');
      return;
    }
    this.onEvent(message);
  }

  private onEvent(message: TerminalSidecarEvent): void {
    const process = this.processes.get(message.payload.terminalId);
    if (!process) return;
    if (message.event === 'output') {
      process.emitBytes(Buffer.from(message.payload.dataBase64, 'base64'));
      return;
    }
    this.processes.delete(message.payload.terminalId);
    process.emitExit({ exitCode: message.payload.exitCode });
  }

  private onSidecarExit(error: Error): void {
    if (!this.child && this.pending.size === 0 && this.processes.size === 0) return;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    this.rejectPending(error);
    for (const process of this.processes.values()) {
      process.emitExit({ exitCode: 1 });
    }
    this.processes.clear();
    if (!this.disposing) this.log('[rust-pty] sidecar stopped unexpectedly', error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private failProtocol(message: string): void {
    const child = this.child;
    this.onSidecarExit(new Error(message));
    child?.kill('SIGKILL');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTerminalSidecarResponse(value: Record<string, unknown>): value is TerminalSidecarResponse {
  return Number.isSafeInteger(value['id'])
    && typeof value['ok'] === 'boolean'
    && (value['ok'] ? 'value' in value : typeof value['error'] === 'string');
}

function isTerminalSidecarEvent(value: Record<string, unknown>): value is TerminalSidecarEvent {
  const payload = value['payload'];
  if (!isRecord(payload)
    || typeof payload['terminalId'] !== 'string'
    || typeof payload['sessionId'] !== 'string') {
    return false;
  }
  if (value['event'] === 'output') {
    return typeof payload['dataBase64'] === 'string' && Number.isSafeInteger(payload['seq']);
  }
  return value['event'] === 'exit'
    && Number.isSafeInteger(payload['exitCode'])
    && (payload['signalName'] === null || typeof payload['signalName'] === 'string');
}

class RustPtyProcess implements PtyProcess {
  private readonly events = new EventEmitter();
  private readonly decoder = new StringDecoder('utf8');
  private currentPid = 0;
  private exited = false;

  constructor(
    private readonly factory: RustPtyProcessFactory,
    private readonly terminalId: string
  ) {}

  get pid(): number {
    return this.currentPid;
  }

  setPid(pid: number): void {
    this.currentPid = pid;
  }

  onData(listener: (data: string) => void): PtyProcessDisposable {
    this.events.on('data', listener);
    return { dispose: () => this.events.off('data', listener) };
  }

  onExit(listener: (event: PtyProcessExit) => void): PtyProcessDisposable {
    this.events.on('exit', listener);
    return { dispose: () => this.events.off('exit', listener) };
  }

  write(data: string): void {
    if (!this.exited) this.factory.write(this.terminalId, data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.factory.resize(this.terminalId, cols, rows);
  }

  kill(): void {
    if (!this.exited) this.factory.stop(this.terminalId);
  }

  emitBytes(data: Buffer): void {
    if (this.exited) return;
    const decoded = this.decoder.write(data);
    if (decoded) this.events.emit('data', decoded);
  }

  emitExit(event: PtyProcessExit): void {
    if (this.exited) return;
    this.exited = true;
    const final = this.decoder.end();
    if (final) this.events.emit('data', final);
    this.events.emit('exit', event);
    this.events.removeAllListeners();
  }
}
