import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type {
  RunMode,
  Session,
  SessionId,
  AgentRuntimeProvider,
  SessionRuntimeState,
  SessionStatus
} from '@shared/types/sessions.js';
import { effectiveAgentProvider } from '@shared/types/sessions.js';
import { sessionAutoApprovesPermissions as launchAutoApprovesPermissions } from '@shared/agent-permissions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type {
  SpawnSpec,
  TerminalDimensions,
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalReplaySnapshot,
  TerminalStartOptions,
  TerminalStartResult,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from '@shared/types/terminal.js';
import type { SessionCommandBuilder } from '../sessions/SessionCommandBuilder.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { AgentObserverManager } from '../agents/AgentObserverManager.js';
import {
  isApprovalPromptOutput,
  scanTerminalAgentSignals
} from '@shared/terminal-agent-signals.js';
import {
  CodexConfigReader,
  codexApprovalsAreAutomatic,
  type CodexEffectiveConfig
} from '../agents/CodexConfigReader.js';
import {
  CursorCliDiscovery,
  resolveCursorSessionBinaries
} from '../agents/CursorCliDiscovery.js';
import type { TerminalOutputBatcher } from './TerminalOutputBatcher.js';
import { TerminalReplayBuffer } from './TerminalReplayBuffer.js';
import { detectUsageLimitPlainText, stripAnsi } from '../agents/UsageLimitDetector.js';
import type { UsageLimitInfo } from '../agents/UsageLimitDetector.js';
import { NodePtyProcessFactory } from './NodePtyProcessFactory.js';
import type { PtyProcess, PtyProcessFactory } from './PtyProcess.js';

interface TerminalInstance {
  terminalId: TerminalId;
  sessionId: SessionId;
  pty: PtyProcess;
  spec: SpawnSpec;
  runMode: RunMode;
  cols: number;
  rows: number;
  status: SessionStatus;
  startedAt: string;
  cwd: string;
  locationBuffer: string;
  agentSignalTail: string;
  usageLimitBuffer: string;
  usageLimitDetected: boolean;
  agentProvider: AgentRuntimeProvider | null;
  autoApprovesPermissions: boolean;
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
  replayBuffer?: TerminalReplayBuffer;
  processFactory?: PtyProcessFactory;
  codexConfigReader?: CodexConfigReader;
  cursorDiscovery?: Pick<CursorCliDiscovery, 'detect'>;
}

export declare interface PtyManager {
  on<K extends keyof PtyManagerEvents>(event: K, listener: (...args: PtyManagerEvents[K]) => void): this;
  off<K extends keyof PtyManagerEvents>(event: K, listener: (...args: PtyManagerEvents[K]) => void): this;
  emit<K extends keyof PtyManagerEvents>(event: K, ...args: PtyManagerEvents[K]): boolean;
}

const AGENT_SPAWN_SETTLE_MS = 600;

export class PtyManager extends EventEmitter {
  private readonly terminals = new Map<TerminalId, TerminalInstance>();
  private readonly sessionToTerminal = new Map<SessionId, TerminalId>();
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly agentSpawnQueues = new Map<string, Promise<void>>();
  private readonly pendingAgentInputPersistence = new Map<SessionId, Promise<void>>();
  private readonly replayBuffer: TerminalReplayBuffer;
  private readonly processFactory: PtyProcessFactory;
  private readonly codexConfigReader: CodexConfigReader;
  private readonly cursorDiscovery: Pick<CursorCliDiscovery, 'detect'>;
  private disposed = false;

  constructor(private readonly opts: PtyManagerOptions) {
    super();
    this.baseEnv = opts.baseEnv ?? process.env;
    this.replayBuffer = opts.replayBuffer ?? new TerminalReplayBuffer();
    this.processFactory = opts.processFactory ?? new NodePtyProcessFactory();
    this.cursorDiscovery = opts.cursorDiscovery ?? new CursorCliDiscovery();
    this.codexConfigReader = opts.codexConfigReader ?? new CodexConfigReader({
      commandBuilder: opts.commandBuilder,
      processFactory: this.processFactory,
      baseEnv: this.baseEnv,
      log: (message, detail) => console.warn(`[codex-config] ${message}`, detail)
    });
  }

  forwardBatchedOutput(events: TerminalOutputEvent[]): void {
    for (const ev of events) {
      const instance = this.terminals.get(ev.terminalId);
      if (instance?.sessionId === ev.sessionId) {
        // Semantic observation follows the 16 ms output boundary instead of
        // rescanning every raw node-pty chunk. Replay and publication still
        // receive the exact same ordered bytes.
        this.handleLocationSequences(instance, ev.data);
        this.handleAgentOutput(instance, ev.data);
      }
      this.replayBuffer.append(ev);
      this.emit('output', ev);
    }
  }

  replay(terminalId: TerminalId, afterSeq = 0): TerminalReplaySnapshot | null {
    return this.replayBuffer.snapshot(terminalId, afterSeq);
  }

  async setKeepFullHistory(enabled: boolean): Promise<void> {
    this.replayBuffer.setUnbounded(enabled);
    await this.processFactory.setReplayUnbounded?.(enabled);
  }

  async start(options: TerminalStartOptions): Promise<TerminalStartResult> {
    if (this.disposed) throw new Error('PtyManager disposed');
    const { sessionId } = options;
    const existingTerminalId = this.sessionToTerminal.get(sessionId);
    if (existingTerminalId) {
      const existing = this.terminals.get(existingTerminalId);
      if (existing?.status === 'running') {
        return {
          terminalId: existing.terminalId,
          sessionId: existing.sessionId,
          pid: existing.pty.pid,
          spec: existing.spec
        };
      }
      throw new Error(`Session ${sessionId} is already running`);
    }
    await this.pendingAgentInputPersistence.get(sessionId);
    const session = await this.opts.store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    this.opts.observer?.registerTuiSession(session);
    const bridge = this.opts.bridgeInfo?.() ?? undefined;
    const configuredBinaries = this.opts.getBinaries ? await this.opts.getBinaries() : undefined;
    const binaries = await resolveCursorSessionBinaries(
      session,
      configuredBinaries,
      this.cursorDiscovery
    );
    const spec = this.opts.commandBuilder.build(session, {
      baseEnv: this.baseEnv,
      bridge,
      ...(binaries ? { binaries } : {})
    });
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const terminalId = newTerminalId();

    this.sessionToTerminal.set(sessionId, terminalId);
    this.emitStatus(sessionId, terminalId, 'starting');
    await nextTick();

    const agentProvider = effectiveAgentProvider(session) ?? legacyAgentProvider(session);
    const autoApprovesPermissions = await this.sessionAutoApprovesPermissions(
      session,
      binaries,
      true
    );
    this.opts.observer?.setAutoApprovesPermissions(sessionId, autoApprovesPermissions);
    const release = agentProvider ? await this.acquireAgentSpawnSlot(agentProvider) : noop;
    let proc: PtyProcess;
    try {
      proc = await this.processFactory.spawn({
        terminalId,
        sessionId,
        spec,
        cols,
        rows,
        env: mergeEnv(this.baseEnv, spec.env)
      });
    } catch (err) {
      release();
      const message = errorMessage(err);
      this.sessionToTerminal.delete(sessionId);
      this.emitStatus(sessionId, terminalId, 'error', message);
      throw new Error(`Failed to spawn terminal: ${message}`);
    }
    if (agentProvider) {
      // Codex and Claude lock their on-disk state during startup; let this one
      // settle before the next agent spawn reads or writes the same files.
      setTimeout(release, AGENT_SPAWN_SETTLE_MS);
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
      locationBuffer: '',
      agentSignalTail: '',
      usageLimitBuffer: '',
      usageLimitDetected: false,
      agentProvider,
      autoApprovesPermissions
    };
    this.terminals.set(terminalId, instance);
    this.attachProcess(instance);

    void this.opts.store.touch(sessionId).catch(() => {});

    this.emitStatus(sessionId, terminalId, 'running');

    return { terminalId, sessionId, pid: proc.pid, spec };
  }

  async rehydrate(): Promise<void> {
    if (!this.processFactory.listRunning || !this.processFactory.attach) return;
    const running = await this.processFactory.listRunning();
    const binaries = this.opts.getBinaries ? await this.opts.getBinaries() : undefined;
    for (const terminal of running) {
      if (
        this.terminals.has(terminal.terminalId)
        || this.sessionToTerminal.has(terminal.sessionId)
      ) {
        continue;
      }
      const session = await this.opts.store.get(terminal.sessionId);
      if (!session) continue;
      const proc = this.processFactory.attach(terminal);
      const spec: SpawnSpec = {
        ...terminal.spec,
        description:
          terminal.spec.description
          ?? [terminal.spec.file, ...terminal.spec.args].join(' ')
      };
      const autoApprovesPermissions = await this.sessionAutoApprovesPermissions(session, binaries);
      const instance: TerminalInstance = {
        terminalId: terminal.terminalId,
        sessionId: terminal.sessionId,
        pty: proc,
        spec,
        runMode: session.runMode,
        cols: terminal.cols,
        rows: terminal.rows,
        status: 'running',
        startedAt: terminal.startedAt,
        cwd: session.cwd,
        locationBuffer: '',
        agentSignalTail: '',
        usageLimitBuffer: '',
        usageLimitDetected: false,
        agentProvider: effectiveAgentProvider(session) ?? legacyAgentProvider(session),
        autoApprovesPermissions
      };
      this.terminals.set(terminal.terminalId, instance);
      this.sessionToTerminal.set(terminal.sessionId, terminal.terminalId);
      this.opts.observer?.registerTuiSession(session);
      this.opts.observer?.setAutoApprovesPermissions(
        terminal.sessionId,
        autoApprovesPermissions
      );
      this.attachProcess(instance);
    }
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
    this.handleAgentInputState(instance, data);
    this.clearApprovalStateOnInput(instance.sessionId, data);
    instance.pty.write(data);
  }

  private handleAgentInputState(instance: TerminalInstance, data: string): void {
    if (!instance.agentProvider) return;
    const submitted = /[\r\n]/.test(data);
    if (submitted) {
      this.markAgentSessionResumable(instance.sessionId);
    }
    const snapshot = this.opts.observer?.getSnapshot(instance.sessionId);
    if (
      instance.agentProvider === 'cursor'
      && submitted
      && snapshot?.state === 'idle'
    ) {
      // Cursor's interactive TUI does not expose a structured prompt lifecycle
      // on the parent PTY. Treat submission (not draft keystrokes) as the start
      // of work; explicit ACP events remain authoritative for worker sessions.
      this.opts.observer?.setTuiObservedState(
        instance.sessionId,
        'working',
        'prompt submitted'
      );
    }
    if (!data.includes('\x03')) return;
    if (!snapshot || snapshot.state === 'idle' || snapshot.state === 'exited') return;
    this.opts.observer?.setTuiObservedState(instance.sessionId, 'idle', 'idle');
  }

  private markAgentSessionResumable(sessionId: SessionId): void {
    if (this.pendingAgentInputPersistence.has(sessionId)) return;
    const persistence = this.opts.store
      .get(sessionId)
      .then(async (session) => {
        if (!session || session.hasUserInput === true) return;
        await this.opts.store.update(sessionId, { hasUserInput: true });
      })
      .catch((err) => {
        console.warn(`[terminal] failed to persist agent input for ${sessionId}`, err);
      })
      .finally(() => {
        if (this.pendingAgentInputPersistence.get(sessionId) === persistence) {
          this.pendingAgentInputPersistence.delete(sessionId);
        }
      });
    this.pendingAgentInputPersistence.set(sessionId, persistence);
  }

  private clearApprovalStateOnInput(sessionId: SessionId, data: string): void {
    if (!data) return;
    const snapshot = this.opts.observer?.getSnapshot(sessionId);
    if (snapshot?.state !== 'waiting_for_approval') return;
    this.opts.observer?.setTuiObservedState(
      sessionId,
      'working',
      'approval answered'
    );
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

  async readCodexConfig(
    session: Session,
    binaries?: SettingsBinaries,
    refresh = false
  ): Promise<CodexEffectiveConfig | null> {
    if (effectiveAgentProvider(session) !== 'codex') return null;
    return this.codexConfigReader.read(session, binaries, refresh);
  }

  async sessionAutoApprovesPermissions(
    session: Session,
    binaries?: SettingsBinaries,
    refresh = false
  ): Promise<boolean> {
    if (launchAutoApprovesPermissions(session)) return true;
    if (effectiveAgentProvider(session) !== 'codex') return false;
    return codexApprovalsAreAutomatic(await this.readCodexConfig(session, binaries, refresh));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.processFactory.preservesProcessesOnDispose) {
      const ids = [...this.terminals.keys()];
      await Promise.all(ids.map((id) => this.stopAndAwait(id, 1500)));
    }
    this.terminals.clear();
    this.sessionToTerminal.clear();
    this.opts.batcher.destroy();
    this.codexConfigReader.clear();
    this.replayBuffer.clear();
    this.removeAllListeners();
    await this.processFactory.dispose?.();
  }

  private async acquireAgentSpawnSlot(kind: AgentRuntimeProvider): Promise<() => void> {
    const previous = this.agentSpawnQueues.get(kind) ?? Promise.resolve();
    let release: () => void = noop;
    const next = new Promise<void>((resolve) => {
      release = () => {
        if (this.agentSpawnQueues.get(kind) === next) {
          this.agentSpawnQueues.delete(kind);
        }
        resolve();
      };
    });
    this.agentSpawnQueues.set(kind, previous.then(() => next));
    await previous;
    return release;
  }

  private attachProcess(instance: TerminalInstance): void {
    instance.pty.onData((data) => {
      if (this.processFactory.outputIsPrebatched) {
        this.opts.batcher.pushPrebatched(instance.terminalId, instance.sessionId, data);
      } else {
        this.opts.batcher.push(instance.terminalId, instance.sessionId, data);
      }
    });
    instance.pty.onExit(({ exitCode, signal }) => {
      this.handleExit(instance.terminalId, exitCode, signal ?? null);
    });
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
    this.replayBuffer.remove(terminalId);
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
    if (!instance.locationBuffer && !data.includes('\x1b]')) {
      // Preserve a split OSC opener without running two regex scans over
      // ordinary ANSI redraws, which overwhelmingly contain CSI (`ESC [`)
      // rather than shell-location OSC (`ESC ]`) sequences.
      instance.locationBuffer = data.endsWith('\x1b') ? '\x1b' : '';
      return;
    }
    const text = instance.locationBuffer + data;
    const regex = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      const payload = match[1] ?? '';
      const cwd = cwdFromOsc(payload, instance.runMode);
      if (cwd) this.emitLocation(instance, cwd);
    }

    const lastStart = text.lastIndexOf('\x1b]');
    if (lastStart >= 0 && !hasOscTerminator(text, lastStart)) {
      instance.locationBuffer = text.slice(lastStart, lastStart + 4096);
    } else {
      instance.locationBuffer = text.endsWith('\x1b') ? '\x1b' : '';
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

  private handleAgentOutput(instance: TerminalInstance, data: string): void {
    if (!instance.agentProvider) return;

    // Semantic scanning now runs once per 16 ms batch. Plain output needs no
    // allocation; ANSI output is stripped before the visible tail/candidate
    // gate so styling may safely split words such as `per…mission`.
    const signal = scanTerminalAgentSignals(instance.agentSignalTail, data);
    instance.agentSignalTail = signal.tail;
    const signalText = signal.candidateText;
    if (!signalText) return;

    const observedState = this.opts.observer?.getSnapshot(instance.sessionId)?.state;
    if (
      isApprovalPromptOutput(signalText, instance.agentProvider)
      && !instance.autoApprovesPermissions
      && observedState !== 'waiting_for_approval'
      && observedState !== 'usage_limited'
    ) {
      this.opts.observer?.setTuiObservedState(
        instance.sessionId,
        'waiting_for_approval',
        'waiting for approval'
      );
    }

    if (instance.usageLimitDetected || !USAGE_LIMIT_CANDIDATE.test(signalText)) return;
    instance.usageLimitBuffer = `${instance.usageLimitBuffer}${signalText}`.slice(-4096);
    const usageLimit = detectUsageLimitPlainText(instance.usageLimitBuffer);
    if (!usageLimit) return;
    instance.usageLimitDetected = true;
    void this.logUsageLimitDetection(instance, usageLimit, signal.text);
    this.opts.observer?.setTuiUsageLimit(instance.sessionId, {
      ...usageLimit,
      detectedAt: new Date().toISOString()
    });
  }

  private async logUsageLimitDetection(
    instance: TerminalInstance,
    usageLimit: UsageLimitInfo,
    latestOutput: string
  ): Promise<void> {
    const session = await this.opts.store.get(instance.sessionId).catch(() => null);
    console.log('[soloe-limit] usage limit detected from terminal output', {
      source: 'pty',
      provider: session ? effectiveAgentProvider(session) : null,
      terminalId: instance.terminalId,
      sessionId: instance.sessionId,
      sessionName: session?.name ?? null,
      cwd: session?.cwd ?? instance.cwd,
      runMode: session?.runMode ?? instance.runMode,
      launchProvider: session ? effectiveAgentProvider(session) : null,
      currentAgentRuntime: session?.currentAgentRuntime ?? null,
      providerThreadId: session?.providerThreadId ?? null,
      transcriptPath: session?.transcriptPath ?? null,
      command: {
        file: instance.spec.file,
        args: instance.spec.args
      },
      usageLimit: {
        message: usageLimit.message,
        resetAtLabel: usageLimit.resetAtLabel ?? null,
        detectorVersion: usageLimit.detectorVersion,
        matchedText: usageLimit.matchedText ?? null
      },
      latestOutputSnippet: shortLogText(latestOutput, 1200),
      detectionBufferSnippet: shortLogText(instance.usageLimitBuffer, 2400)
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

const noop = (): void => {};

const USAGE_LIMIT_CANDIDATE = /limit|credit/i;

function legacyAgentProvider(session: Session): AgentRuntimeProvider | null {
  const kind = (session as unknown as { kind?: unknown }).kind;
  if (kind === 'claude_code' || kind === 'codex' || kind === 'cursor') return kind;
  return null;
}

function newTerminalId(): TerminalId {
  return `t-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function shortLogText(value: string, maxLength: number): string {
  const normalized = stripAnsi(value).replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(-maxLength + 3)}...`;
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

function hasOscTerminator(text: string, start: number): boolean {
  const bel = text.indexOf('\x07', start);
  const st = text.indexOf('\x1b\\', start);
  return bel >= 0 || st >= 0;
}

function cwdFromOsc(payload: string, runMode: RunMode): string | null {
  if (payload.startsWith('7;')) {
    return cwdFromLocationValue(payload.slice(2), runMode);
  }
  if (payload.startsWith('633;P;')) {
    const cwd = propertyValue(payload.slice('633;P;'.length), 'Cwd');
    return cwd ? cwdFromLocationValue(unescapeIntegrationValue(cwd), runMode) : null;
  }
  if (payload.startsWith('1337;CurrentDir=')) {
    return cwdFromLocationValue(
      unescapeIntegrationValue(payload.slice('1337;CurrentDir='.length)),
      runMode
    );
  }
  return null;
}

function cwdFromLocationValue(payload: string, runMode: RunMode): string | null {
  if (!payload.startsWith('file://')) return normalizeOscPath(payload, runMode);
  try {
    const url = new URL(payload);
    if (url.protocol !== 'file:') return null;
    const pathname = decodeURIComponent(url.pathname);
    return normalizeOscPath(pathname, runMode);
  } catch {
    return null;
  }
}

function propertyValue(payload: string, name: string): string | null {
  const prefix = `${name}=`;
  if (payload.startsWith(prefix)) return payload.slice(prefix.length);
  const marker = `;${prefix}`;
  const index = payload.indexOf(marker);
  if (index < 0) return null;
  return payload.slice(index + marker.length);
}

function unescapeIntegrationValue(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
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
