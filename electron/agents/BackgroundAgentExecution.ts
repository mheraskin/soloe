import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import type { ModelSelection, SettingsBinaries } from '@shared/types/settings.js';
import { CLI_DEFAULT_MODEL_ID } from '@shared/model-catalog.js';
import type { RunMode } from '@shared/types/sessions.js';
import { WslCommandBuilder } from '../runtime/WslCommandBuilder.js';
import {
  buildWslAgentLine,
  buildWslAgentProbeLine
} from '../sessions/SessionCommandBuilder.js';

export type BackgroundAgentPriority = 'interactive' | 'background';

export interface BackgroundAgentScope {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
}

export interface BackgroundAgentRequest {
  candidates: ModelSelection[];
  binaries: SettingsBinaries;
  scope: BackgroundAgentScope;
  prompt: string;
  timeoutMs: number;
  priority: BackgroundAgentPriority;
  maxOutputBytes?: number;
  validate?: () => Promise<boolean> | boolean;
  signal?: AbortSignal;
}

export type BackgroundAgentResult =
  | { ok: true; text: string; provider: ModelSelection }
  | { ok: false; reason: 'unavailable' | 'cancelled' | 'failed'; error: string };

export type BackgroundAgentChunk =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface BackgroundAgentExecutionOptions {
  spawnImpl?: typeof spawn;
  isExecutableAvailable?: (
    executable: string,
    scope: BackgroundAgentScope
  ) => Promise<boolean> | boolean;
  maxConcurrency?: number;
  maxBackgroundConcurrency?: number;
  availabilityCacheMs?: number;
}

interface Admission {
  priority: BackgroundAgentPriority;
  sequence: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: (() => void) | null) => void;
}

const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_BACKGROUND_CONCURRENCY = 1;
const DEFAULT_AVAILABILITY_CACHE_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const AVAILABILITY_TIMEOUT_MS = 3_000;

/**
 * Owns provider availability, global process admission, native/WSL launch,
 * timeout, cancellation, and bounded output for Soloe-dispatched agents.
 */
export class BackgroundAgentExecution {
  private readonly spawnImpl: typeof spawn;
  private readonly availabilityProbe: (
    executable: string,
    scope: BackgroundAgentScope
  ) => Promise<boolean>;
  private readonly maxConcurrency: number;
  private readonly maxBackgroundConcurrency: number;
  private readonly availabilityCacheMs: number;
  private readonly availability = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly admissions: Admission[] = [];
  private active = 0;
  private activeBackground = 0;
  private sequence = 0;
  private disposed = false;
  private readonly activeCancellations = new Set<() => void>();

  constructor(options: BackgroundAgentExecutionOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.availabilityProbe = options.isExecutableAvailable
      ? async (executable, scope) => options.isExecutableAvailable!(executable, scope)
      : (executable, scope) => this.probeExecutable(executable, scope);
    this.maxConcurrency = positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    this.maxBackgroundConcurrency = Math.min(
      this.maxConcurrency,
      positiveInteger(options.maxBackgroundConcurrency, DEFAULT_MAX_BACKGROUND_CONCURRENCY)
    );
    this.availabilityCacheMs = Math.max(
      0,
      Math.trunc(options.availabilityCacheMs ?? DEFAULT_AVAILABILITY_CACHE_MS)
    );
  }

  async execute(request: BackgroundAgentRequest): Promise<BackgroundAgentResult> {
    const release = await this.acquire(request.priority, request.signal);
    if (!release) return cancelledResult();
    try {
      if (!(await this.isStillValid(request))) return cancelledResult();
      const resolved = await this.resolveProvider(request);
      if (!resolved) return unavailableResult();
      if (!(await this.isStillValid(request))) return cancelledResult();
      return await this.runOneShot(request, resolved);
    } finally {
      release();
    }
  }

  async *stream(request: BackgroundAgentRequest): AsyncIterable<BackgroundAgentChunk> {
    const release = await this.acquire(request.priority, request.signal);
    if (!release) {
      yield { type: 'error', error: cancelledResult().error };
      return;
    }
    let child: ChildProcess | null = null;
    let completed = false;
    let cancelActive: (() => void) | null = null;
    try {
      if (!(await this.isStillValid(request))) {
        yield { type: 'error', error: cancelledResult().error };
        return;
      }
      const resolved = await this.resolveProvider(request);
      if (!resolved) {
        yield { type: 'error', error: unavailableResult().error };
        return;
      }
      if (!(await this.isStillValid(request))) {
        yield { type: 'error', error: cancelledResult().error };
        return;
      }

      child = this.launch(resolved, request);
      writePrompt(child, request.prompt);
      const queue: BackgroundAgentChunk[] = [];
      let wake: (() => void) | null = null;
      let settled = false;
      let stderr = '';
      const push = (chunk: BackgroundAgentChunk): void => {
        queue.push(chunk);
        const notify = wake;
        wake = null;
        notify?.();
      };
      let timeout: NodeJS.Timeout | null = null;
      const cancel = () => {
        if (settled) return;
        settled = true;
        kill(child!);
        if (timeout) clearTimeout(timeout);
        push({ type: 'error', error: cancelledResult().error });
      };
      cancelActive = cancel;
      this.activeCancellations.add(cancel);
      request.signal?.addEventListener('abort', cancel, { once: true });
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        kill(child!);
        push({ type: 'error', error: `background agent timed out after ${request.timeoutMs}ms` });
      }, request.timeoutMs);
      if (request.signal?.aborted) cancel();
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => push({ type: 'delta', text: chunk }));
      child.stderr?.on('data', (chunk: string) => {
        stderr = appendBounded(stderr, chunk, request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        push({ type: 'error', error: error.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (code !== 0) {
          push({ type: 'error', error: stderr.trim() || `exit ${code}` });
          return;
        }
        completed = true;
        push({ type: 'done' });
      });

      while (true) {
        while (queue.length > 0) {
          const next = queue.shift()!;
          yield next;
          if (next.type === 'done' || next.type === 'error') return;
        }
        if (settled) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } catch (error) {
      yield { type: 'error', error: errorMessage(error) };
    } finally {
      if (child && !completed) {
        if (cancelActive) cancelActive();
        else kill(child);
      }
      if (cancelActive) {
        request.signal?.removeEventListener('abort', cancelActive);
        this.activeCancellations.delete(cancelActive);
      }
      release();
    }
  }

  private async runOneShot(
    request: BackgroundAgentRequest,
    provider: ModelSelection
  ): Promise<BackgroundAgentResult> {
    return new Promise<BackgroundAgentResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.launch(provider, request);
      } catch (error) {
        resolve({ ok: false, reason: 'failed', error: errorMessage(error) });
        return;
      }
      writePrompt(child, request.prompt);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        request.signal?.removeEventListener('abort', cancel);
        this.activeCancellations.delete(cancel);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        kill(child);
        cleanup();
        resolve(cancelledResult());
      };
      this.activeCancellations.add(cancel);
      request.signal?.addEventListener('abort', cancel, { once: true });
      if (request.signal?.aborted) {
        cancel();
        return;
      }
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        kill(child);
        cleanup();
        resolve({
          ok: false,
          reason: 'failed',
          error: `background agent timed out after ${request.timeoutMs}ms`
        });
      }, request.timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = appendBounded(stdout, chunk, limit);
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr = appendBounded(stderr, chunk, limit);
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, reason: 'failed', error: error.message });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code !== 0) {
          const detail = (stderr.trim() || stdout.trim()).slice(-limit);
          resolve({
            ok: false,
            reason: 'failed',
            error: detail ? `${detail} (exit ${code})` : `exit ${code}`
          });
          return;
        }
        resolve({ ok: true, text: stdout.trim(), provider });
      });
    });
  }

  private async resolveProvider(request: BackgroundAgentRequest): Promise<ModelSelection | null> {
    const seen = new Set<string>();
    for (const candidate of request.candidates) {
      const key = `${candidate.provider}\u001f${candidate.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const executable = executableFor(candidate, request.binaries);
      if (await this.isAvailable(executable, request.scope)) return candidate;
    }
    return null;
  }

  private async isAvailable(executable: string, scope: BackgroundAgentScope): Promise<boolean> {
    const key = [scope.runMode, scope.wslDistro ?? '', executable].join('\u001f');
    const cached = this.availability.get(key);
    if (cached && cached.expiresAt >= Date.now()) return cached.value;
    const value = await this.availabilityProbe(executable, scope).catch(() => false);
    this.availability.set(key, { value, expiresAt: Date.now() + this.availabilityCacheMs });
    return value;
  }

  private launch(provider: ModelSelection, request: BackgroundAgentRequest): ChildProcess {
    const argv = buildArgv(provider, request.binaries);
    if (request.scope.runMode === 'wsl') {
      const inner = buildWslAgentLine({}, argv.executable, argv.args);
      return this.spawnImpl(
        WslCommandBuilder.WSL_EXE,
        [
          '-d', request.scope.wslDistro ?? 'Ubuntu',
          '--cd', request.scope.cwd,
          'bash', '-lc', inner
        ],
        processOptions(hostHome())
      );
    }
    if (request.scope.runMode === 'linux') {
      // Use the native login shell only to resolve user-managed binaries
      // (nvm, bun, ~/.local/bin), then exec the agent in the native Linux process
      // and filesystem. No WSL or host bridge is involved.
      const inner = buildWslAgentLine({}, argv.executable, argv.args);
      return this.spawnImpl('bash', ['-lc', inner], processOptions(request.scope.cwd));
    }
    if (process.platform === 'win32' && /\.(?:bat|cmd)$/iu.test(argv.executable)) {
      return this.spawnImpl(
        process.env['ComSpec'] ?? 'cmd.exe',
        ['/d', '/s', '/c', argv.executable, ...argv.args],
        processOptions(request.scope.cwd)
      );
    }
    return this.spawnImpl(argv.executable, argv.args, processOptions(request.scope.cwd));
  }

  private async probeExecutable(executable: string, scope: BackgroundAgentScope): Promise<boolean> {
    if (scope.runMode !== 'wsl' && hasPathSeparator(executable)) {
      return fs.access(executable, fsConstants.F_OK).then(() => true, () => false);
    }
    const command = scope.runMode === 'wsl' ? WslCommandBuilder.WSL_EXE : nativeProbeCommand();
    const args = scope.runMode === 'wsl'
      ? [
          '-d', scope.wslDistro ?? 'Ubuntu',
          'bash', '-lc', buildWslAgentProbeLine(executable)
        ]
      : nativeProbeArgs(executable);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let child: ChildProcess;
      try {
        child = this.spawnImpl(command, args, {
          cwd: scope.runMode === 'wsl' ? hostHome() : undefined,
          env: process.env,
          stdio: 'ignore',
          windowsHide: true
        });
      } catch {
        resolve(false);
        return;
      }
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        kill(child);
        finish(false);
      }, AVAILABILITY_TIMEOUT_MS);
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const admission of this.admissions.splice(0)) {
      admission.signal?.removeEventListener('abort', admission.onAbort!);
      admission.resolve(null);
    }
    for (const cancel of [...this.activeCancellations]) cancel();
    this.activeCancellations.clear();
    this.availability.clear();
    await Promise.resolve();
  }

  private acquire(
    priority: BackgroundAgentPriority,
    signal?: AbortSignal
  ): Promise<(() => void) | null> {
    if (this.disposed || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const admission: Admission = { priority, sequence: this.sequence++, resolve, signal };
      if (signal) {
        admission.onAbort = () => {
          const index = this.admissions.indexOf(admission);
          if (index >= 0) this.admissions.splice(index, 1);
          resolve(null);
        };
        signal.addEventListener('abort', admission.onAbort, { once: true });
      }
      this.admissions.push(admission);
      this.drainAdmissions();
    });
  }

  private drainAdmissions(): void {
    while (this.active < this.maxConcurrency) {
      const index = this.nextAdmissionIndex();
      if (index < 0) return;
      const [entry] = this.admissions.splice(index, 1);
      if (!entry) return;
      if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
      if (entry.signal?.aborted || this.disposed) {
        entry.resolve(null);
        continue;
      }
      this.active += 1;
      if (entry.priority === 'background') this.activeBackground += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        if (entry.priority === 'background') {
          this.activeBackground = Math.max(0, this.activeBackground - 1);
        }
        this.drainAdmissions();
      });
    }
  }

  private nextAdmissionIndex(): number {
    let fallback = -1;
    for (let index = 0; index < this.admissions.length; index += 1) {
      const entry = this.admissions[index];
      if (!entry) continue;
      if (entry.priority === 'interactive') return index;
      if (this.activeBackground >= this.maxBackgroundConcurrency) continue;
      if (fallback < 0 || entry.sequence < this.admissions[fallback]!.sequence) fallback = index;
    }
    return fallback;
  }

  private async isStillValid(request: BackgroundAgentRequest): Promise<boolean> {
    if (this.disposed || request.signal?.aborted) return false;
    return isStillValid(request.validate);
  }
}

function buildArgv(
  target: ModelSelection,
  binaries: SettingsBinaries
): { executable: string; args: string[] } {
  if (target.provider === 'codex') {
    const modelArgs = target.id === CLI_DEFAULT_MODEL_ID ? [] : ['-m', target.id];
    return {
      executable: binaries.codex || 'codex',
      args: ['exec', '--skip-git-repo-check', '--color', 'never', ...modelArgs]
    };
  }
  const modelArgs = target.id === CLI_DEFAULT_MODEL_ID ? [] : ['--model', target.id];
  return {
    executable: binaries.claude || 'claude',
    args: ['-p', ...modelArgs, '--output-format', 'text']
  };
}

function executableFor(target: ModelSelection, binaries: SettingsBinaries): string {
  return target.provider === 'codex' ? binaries.codex || 'codex' : binaries.claude || 'claude';
}

function processOptions(cwd: string | undefined) {
  return {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  };
}

function writePrompt(child: ChildProcess, prompt: string): void {
  if (!child.stdin) return;
  child.stdin.on('error', () => {});
  child.stdin.end(prompt, 'utf8');
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  return next.length <= maxBytes ? next : next.slice(-maxBytes);
}

function unavailableResult(): Extract<BackgroundAgentResult, { ok: false }> {
  return {
    ok: false,
    reason: 'unavailable',
    error: 'No configured Claude or Codex executable is available in this runtime.'
  };
}

function cancelledResult(): Extract<BackgroundAgentResult, { ok: false }> {
  return { ok: false, reason: 'cancelled', error: 'Background agent request was cancelled.' };
}

async function isStillValid(validate: BackgroundAgentRequest['validate']): Promise<boolean> {
  return validate ? Boolean(await validate()) : true;
}

function nativeProbeCommand(): string {
  return process.platform === 'win32' ? 'where.exe' : 'sh';
}

function nativeProbeArgs(executable: string): string[] {
  return process.platform === 'win32'
    ? [executable]
    : ['-lc', 'command -v -- "$1" >/dev/null 2>&1', 'soloe-probe', executable];
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function hostHome(): string {
  return process.env['USERPROFILE'] ?? process.env['HOME'] ?? os.homedir();
}

function kill(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      return;
    } catch {
      // Fall through to the direct child when taskkill is unavailable.
    }
  }
  try { child.kill('SIGKILL'); } catch { /* best effort */ }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = Math.trunc(value ?? fallback);
  return resolved > 0 ? resolved : fallback;
}
