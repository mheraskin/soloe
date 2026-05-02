import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import type {
  RunMode,
  SessionId,
  SessionRuntimeState,
  SessionStatus
} from '@shared/types/sessions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type {
  SpawnSpec,
  TerminalDimensions,
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStartResult,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from '@shared/types/terminal.js';
import type { SessionCommandBuilder } from '../sessions/SessionCommandBuilder.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { AgentObserverManager } from '../agents/AgentObserverManager.js';
import type { TerminalOutputBatcher } from './TerminalOutputBatcher.js';

interface TerminalInstance {
  terminalId: TerminalId;
  sessionId: SessionId;
  pty: pty.IPty;
  spec: SpawnSpec;
  runMode: RunMode;
  cols: number;
  rows: number;
  status: SessionStatus;
  startedAt: string;
  cwd: string;
  locationBuffer: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: number | null;
}

type PtyManagerEvents = {
  output: [TerminalOutputEvent];
  exit: [TerminalExitEvent];
  status: [TerminalStatusEvent];
  location: [TerminalLocationEvent];
};

export interface PtyManagerOptions {
  commandBuilder: SessionCommandBuilder;
  store: SessionStore;
  batcher: TerminalOutputBatcher;
  baseEnv?: NodeJS.ProcessEnv;
  observer?: AgentObserverManager;
  bridgeInfo?: () => { url: string; token: string } | null;
  getBinaries?: () => Promise<SettingsBinaries> | SettingsBinaries;
}

export declare interface PtyManager {
  on<K extends keyof PtyManagerEvents>(event: K, listener: (...args: PtyManagerEvents[K]) => void): this;
  off<K extends keyof PtyManagerEvents>(event: K, listener: (...args: PtyManagerEvents[K]) => void): this;
  emit<K extends keyof PtyManagerEvents>(event: K, ...args: PtyManagerEvents[K]): boolean;
}

export class PtyManager extends EventEmitter {
  private readonly terminals = new Map<TerminalId, TerminalInstance>();
  private readonly sessionToTerminal = new Map<SessionId, TerminalId>();
  private readonly baseEnv: NodeJS.ProcessEnv;
  private disposed = false;

  constructor(private readonly opts: PtyManagerOptions) {
    super();
    this.baseEnv = opts.baseEnv ?? process.env;
  }

  forwardBatchedOutput(events: TerminalOutputEvent[]): void {
    for (const ev of events) this.emit('output', ev);
  }

  async start(options: TerminalStartOptions): Promise<TerminalStartResult> {
    if (this.disposed) throw new Error('PtyManager disposed');
    const { sessionId } = options;
    console.info('[DEBUG-terminal-start] pty start begin', { sessionId });
    if (this.sessionToTerminal.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already running`);
    }
    const session = await this.opts.store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    console.info('[DEBUG-terminal-start] pty session loaded', {
      sessionId,
      kind: session.kind,
      runMode: session.runMode,
      cwd: session.cwd,
      wslDistro: session.wslDistro
    });

    this.opts.observer?.registerTuiSession(session);
    const bridge = this.opts.bridgeInfo?.() ?? undefined;
    const binaries = this.opts.getBinaries ? await this.opts.getBinaries() : undefined;
    const spec = this.opts.commandBuilder.build(session, {
      baseEnv: this.baseEnv,
      bridge,
      ...(binaries ? { binaries } : {})
    });
    console.info('[DEBUG-terminal-start] pty spawn spec built', {
      sessionId,
      file: spec.file,
      args: spec.args.map(redactForLog),
      cwd: spec.cwd
    });
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const terminalId = newTerminalId();

    this.sessionToTerminal.set(sessionId, terminalId);
    this.emitStatus(sessionId, terminalId, 'starting');
    await nextTick();

    let proc: pty.IPty;
    try {
      console.info('[DEBUG-terminal-start] pty before spawn', {
        sessionId,
        terminalId,
        file: spec.file,
        cwd: spec.cwd
      });
      proc = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spec.cwd,
        env: mergeEnv(this.baseEnv, spec.env),
        useConpty: process.platform === 'win32'
      } as pty.IPtyForkOptions);
      console.info('[DEBUG-terminal-start] pty spawn returned', {
        sessionId,
        terminalId,
        pid: proc.pid
      });
    } catch (err) {
      const message = errorMessage(err);
      console.info('[DEBUG-terminal-start] pty spawn threw', { sessionId, terminalId, message });
      this.sessionToTerminal.delete(sessionId);
      this.emitStatus(sessionId, terminalId, 'error', message);
      throw new Error(`Failed to spawn terminal: ${message}`);
    }

    const instance: TerminalInstance = {
      terminalId,
      sessionId,
      pty: proc,
      spec,
      runMode: session.runMode,
      cols,
      rows,
      status: 'running',
      startedAt: new Date().toISOString(),
      cwd: session.cwd,
      locationBuffer: ''
    };
    this.terminals.set(terminalId, instance);

    let loggedFirstOutput = false;
    proc.onData((data) => {
      if (!loggedFirstOutput) {
        loggedFirstOutput = true;
        console.info('[DEBUG-terminal-start] pty first output', {
          sessionId,
          terminalId,
          bytes: data.length
        });
      }
      this.handleLocationSequences(instance, data);
      this.opts.batcher.push(terminalId, sessionId, data);
    });

    proc.onExit(({ exitCode, signal }) => {
      console.info('[DEBUG-terminal-start] pty exit', { sessionId, terminalId, exitCode, signal });
      this.handleExit(terminalId, exitCode, signal ?? null);
    });

    void this.opts.store.touch(sessionId).catch(() => {});

    this.emitStatus(sessionId, terminalId, 'running');
    console.info('[DEBUG-terminal-start] pty start done', { sessionId, terminalId, pid: proc.pid });

    return { terminalId, sessionId, pid: proc.pid, spec };
  }

  async stop(terminalId: TerminalId): Promise<void> {
    await this.stopAndAwait(terminalId);
  }

  async restart(sessionId: SessionId, opts?: { cols?: number; rows?: number }): Promise<TerminalStartResult> {
    const existingId = this.sessionToTerminal.get(sessionId);
    if (existingId) {
      await this.stopAndAwait(existingId);
    }
    return this.start({ sessionId, cols: opts?.cols, rows: opts?.rows });
  }

  write(terminalId: TerminalId, data: string): void {
    const instance = this.terminals.get(terminalId);
    if (!instance || instance.status !== 'running') return;
    instance.pty.write(data);
  }

  resize(terminalId: TerminalId, dimensions: TerminalDimensions): void {
    const instance = this.terminals.get(terminalId);
    if (!instance || instance.status !== 'running') return;
    const cols = Math.max(1, Math.floor(dimensions.cols));
    const rows = Math.max(1, Math.floor(dimensions.rows));
    if (cols === instance.cols && rows === instance.rows) return;
    try {
      instance.pty.resize(cols, rows);
      instance.cols = cols;
      instance.rows = rows;
    } catch {
      // ignore - pty may have just exited
    }
  }

  listRunning(): SessionRuntimeState[] {
    return [...this.terminals.values()].map((t) => this.toRuntimeState(t));
  }

  getRuntimeStateBySession(sessionId: SessionId): SessionRuntimeState | null {
    const terminalId = this.sessionToTerminal.get(sessionId);
    if (!terminalId) return null;
    const instance = this.terminals.get(terminalId);
    return instance ? this.toRuntimeState(instance) : null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const ids = [...this.terminals.keys()];
    await Promise.all(ids.map((id) => this.stopAndAwait(id, 1500)));
    this.opts.batcher.destroy();
    this.removeAllListeners();
  }

  private async stopAndAwait(terminalId: TerminalId, timeoutMs = 2000): Promise<void> {
    const instance = this.terminals.get(terminalId);
    if (!instance) return;
    if (instance.status !== 'running' && instance.status !== 'starting') return;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { exitDisposable.dispose(); } catch {}
        resolve();
      };
      const exitDisposable = instance.pty.onExit(() => finish());
      const timer = setTimeout(() => {
        try {
          instance.pty.kill('SIGKILL');
        } catch {
          // best-effort
        }
        finish();
      }, timeoutMs);
      try {
        instance.pty.kill();
      } catch {
        finish();
      }
    });
  }

  private handleExit(terminalId: TerminalId, exitCode: number | null, signal: number | null): void {
    const instance = this.terminals.get(terminalId);
    if (!instance) return;
    instance.status = 'exited';
    instance.exitedAt = new Date().toISOString();
    instance.exitCode = exitCode;
    instance.signal = signal;
    this.opts.batcher.flushTerminal(terminalId);
    this.opts.batcher.removeTerminal(terminalId);
    const sessionId = instance.sessionId;
    this.sessionToTerminal.delete(sessionId);
    this.emit('exit', { terminalId, sessionId, exitCode, signal });
    this.emitStatus(sessionId, terminalId, 'exited');
    this.terminals.delete(terminalId);
  }

  private emitStatus(
    sessionId: SessionId,
    terminalId: TerminalId | null,
    status: SessionStatus,
    message?: string
  ): void {
    const event: TerminalStatusEvent = { sessionId, terminalId, status };
    if (message !== undefined) event.message = message;
    this.opts.observer?.updateTuiStatus(event);
    this.emit('status', event);
  }

  private handleLocationSequences(instance: TerminalInstance, data: string): void {
    const text = instance.locationBuffer + data;
    const regex = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      const cwd = cwdFromOsc7(match[1] ?? '', instance.runMode);
      if (cwd) this.emitLocation(instance, cwd);
    }

    const lastStart = text.lastIndexOf('\x1b]7;');
    if (lastStart >= 0 && !hasOscTerminator(text, lastStart)) {
      instance.locationBuffer = text.slice(lastStart, lastStart + 4096);
    } else {
      instance.locationBuffer = '';
    }
  }

  private emitLocation(instance: TerminalInstance, cwd: string): void {
    if (cwd === instance.cwd) return;
    instance.cwd = cwd;
    this.emit('location', {
      terminalId: instance.terminalId,
      sessionId: instance.sessionId,
      cwd
    });
  }

  private toRuntimeState(instance: TerminalInstance): SessionRuntimeState {
    const state: SessionRuntimeState = {
      sessionId: instance.sessionId,
      runtimeMode: 'tui',
      status: instance.status,
      observedState: this.opts.observer?.getSnapshot(instance.sessionId)?.state,
      terminalId: instance.terminalId,
      startedAt: instance.startedAt
    };
    if (instance.exitedAt) state.exitedAt = instance.exitedAt;
    if (instance.exitCode !== undefined) state.exitCode = instance.exitCode;
    if (instance.signal !== undefined) state.signal = instance.signal;
    return state;
  }
}

function newTerminalId(): TerminalId {
  return `t-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string') out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v;
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function redactForLog(value: string): string {
  return value
    .replace(/SOLOE_BRIDGE_TOKEN='[^']*'/g, 'SOLOE_BRIDGE_TOKEN=<redacted>')
    .replace(/SOLOE_BRIDGE_TOKEN=\S+/g, 'SOLOE_BRIDGE_TOKEN=<redacted>');
}

function hasOscTerminator(text: string, start: number): boolean {
  const bel = text.indexOf('\x07', start);
  const st = text.indexOf('\x1b\\', start);
  return bel >= 0 || st >= 0;
}

function cwdFromOsc7(payload: string, runMode: RunMode): string | null {
  if (!payload.startsWith('file://')) return null;
  try {
    const url = new URL(payload);
    if (url.protocol !== 'file:') return null;
    const pathname = decodeURIComponent(url.pathname);
    return normalizeOscPath(pathname, runMode);
  } catch {
    return null;
  }
}

function normalizeOscPath(pathname: string, runMode: RunMode): string | null {
  if (!pathname) return null;
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\');
  }
  if (runMode === 'windows' && /^[A-Za-z]:\//.test(pathname)) {
    return pathname.replace(/\//g, '\\');
  }
  if (runMode === 'windows' && pathname.startsWith('//')) {
    return pathname.replace(/\//g, '\\');
  }
  return pathname;
}
