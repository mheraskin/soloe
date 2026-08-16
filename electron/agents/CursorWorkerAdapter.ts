import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkerSdkAdapter, WorkerSdkContext } from './AgentRuntimeManager.js';
import {
  normalizeCursorAcpMessage,
  normalizeCursorStreamEvent,
  type NormalizedCursorEvent
} from './CursorEventNormalizer.js';

const MAX_CAPTURE_BYTES = 512 * 1024;

export interface CursorWorkerAdapterOptions {
  getBinary?: () => Promise<string | undefined> | string | undefined;
}

/** Cursor's first-class ACP adapter, with documented stream JSON as an old-CLI fallback. */
export function createCursorWorkerAdapter(options: CursorWorkerAdapterOptions = {}): WorkerSdkAdapter {
  return {
    async run(prompt, ctx) {
      const configured = await options.getBinary?.();
      const binaries = configured ? [configured] : ['agent', 'cursor-agent'];
      let lastError: unknown;
      for (const binary of binaries) {
        try {
          return await runAcp(binary, prompt, ctx);
        } catch (error) {
          lastError = error;
          if (configured || (!isMissingExecutable(error) && !isUnsupportedAcp(error))) throw error;
          if (isUnsupportedAcp(error)) return runStreamJson(binary, prompt, ctx);
        }
      }
      throw lastError ?? new Error('Cursor Agent CLI is unavailable');
    }
  };
}

interface AcpTransport {
  send(value: Record<string, unknown>): void;
  close(): void;
  onMessage(listener: (value: unknown) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
}

export class CursorAcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  private readonly disposeMessage: () => void;
  private readonly disposeClose: () => void;

  constructor(
    private readonly transport: AcpTransport,
    private readonly ctx: WorkerSdkContext
  ) {
    this.disposeMessage = transport.onMessage((message) => this.handleMessage(message));
    this.disposeClose = transport.onClose((error) => this.rejectPending(error ?? new Error('Cursor ACP exited')));
  }

  async run(prompt: string): Promise<{ resultSummary?: string; providerThreadId?: string }> {
    let sessionId = this.ctx.providerThreadId;
    let forceCloseTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (sessionId) {
        this.transport.send({
          jsonrpc: '2.0',
          method: 'session/cancel',
          params: { sessionId }
        });
      }
      forceCloseTimer = setTimeout(() => this.transport.close(), sessionId ? 2_000 : 0);
      forceCloseTimer.unref();
    };
    this.ctx.signal.addEventListener('abort', cancel, { once: true });
    if (this.ctx.signal.aborted) cancel();
    try {
      if (this.ctx.signal.aborted) throw new Error('Cursor worker cancelled');
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'soloe', title: 'Soloe', version: '0.1.0' }
      });

      if (sessionId) {
        await this.request('session/load', {
          sessionId,
          cwd: this.ctx.cwd ?? process.cwd(),
          mcpServers: []
        });
      } else {
        const created = asRecord(await this.request('session/new', {
          cwd: this.ctx.cwd ?? process.cwd(),
          mcpServers: []
        }));
        sessionId = stringField(created, 'sessionId');
        if (!sessionId) throw new Error('Cursor ACP session/new returned no sessionId');
        this.ctx.emit({
          state: 'starting',
          summary: 'Cursor session created',
          providerThreadId: sessionId
        });
      }

      const response = asRecord(await this.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: prompt }]
      }));
      const stopReason = stringField(response, 'stopReason') ?? 'end_turn';
      if (stopReason === 'cancelled') {
        return { resultSummary: 'Cursor interrupted', providerThreadId: sessionId };
      }
      if (stopReason !== 'end_turn') {
        throw new Error(`Cursor stopped: ${stopReason}`);
      }
      return { resultSummary: 'Cursor completed', providerThreadId: sessionId };
    } finally {
      this.ctx.signal.removeEventListener('abort', cancel);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
    }
  }

  dispose(): void {
    this.disposeMessage();
    this.disposeClose();
    this.rejectPending(new Error('Cursor ACP client disposed'));
    this.transport.close();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private handleMessage(raw: unknown): void {
    const message = asRecord(raw);
    if (!message) return;
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.handleAgentRequest(message);
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      const error = asRecord(message.error);
      if (error) pending.reject(new Error(stringField(error, 'message') ?? 'Cursor ACP request failed'));
      else pending.resolve(message.result);
      return;
    }
    emitNormalized(this.ctx, normalizeCursorAcpMessage(message));
  }

  private handleAgentRequest(message: Record<string, unknown>): void {
    const id = message.id as number;
    const method = message.method as string;
    const params = asRecord(message.params) ?? {};
    emitNormalized(this.ctx, normalizeCursorAcpMessage(message));
    if (method === 'session/request_permission') {
      const options = Array.isArray(params.options) ? params.options.map(asRecord).filter(Boolean) : [];
      const preferred = options.find((option) => stringField(option, 'optionId') === 'allow-once')
        ?? options.find((option) => stringField(option, 'optionId') === 'allow-always')
        ?? options[0];
      const optionId = preferred ? stringField(preferred, 'optionId') : undefined;
      const outcome = this.ctx.autoApprovesPermissions && optionId
        ? { outcome: 'selected', optionId }
        : { outcome: 'cancelled' };
      this.transport.send({ jsonrpc: '2.0', id, result: { outcome } });
      return;
    }
    this.transport.send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Soloe does not support interactive ${method} responses in workers` }
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function runAcp(
  executable: string,
  prompt: string,
  ctx: WorkerSdkContext
): Promise<{ resultSummary?: string; providerThreadId?: string }> {
  const transport = spawnAcpTransport(executable, ctx.cwd);
  const client = new CursorAcpClient(transport, ctx);
  try {
    return await client.run(prompt);
  } finally {
    client.dispose();
  }
}

function spawnAcpTransport(executable: string, cwd?: string): AcpTransport {
  const child = spawn(executable, ['acp'], {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const messageListeners = new Set<(value: unknown) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    if (stdout.length > MAX_CAPTURE_BYTES) {
      child.kill();
      for (const listener of closeListeners) listener(new Error('Cursor ACP output exceeded 512 KiB'));
      return;
    }
    const lines = stdout.split(/\r?\n/u);
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        for (const listener of messageListeners) listener(parsed);
      } catch {
        // ACP is NDJSON; malformed stdout is ignored and a later close/error remains authoritative.
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = appendBounded(stderr, String(chunk), MAX_CAPTURE_BYTES);
  });
  child.once('error', (error) => {
    for (const listener of closeListeners) listener(error);
  });
  child.once('close', (code) => {
    const error = new Error(stderr.trim() || `Cursor ACP exited with code ${code ?? 0}`);
    for (const listener of closeListeners) listener(error);
  });
  return {
    send(value) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    close() { child.kill(); },
    onMessage(listener) { messageListeners.add(listener); return () => messageListeners.delete(listener); },
    onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); }
  };
}

async function runStreamJson(
  executable: string,
  prompt: string,
  ctx: WorkerSdkContext
): Promise<{ resultSummary?: string; providerThreadId?: string }> {
  const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output'];
  if (ctx.providerThreadId) args.push(`--resume=${ctx.providerThreadId}`);
  args.push(prompt);
  const child = spawn(executable, args, {
    cwd: ctx.cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdin.end();
  return consumeCursorStream(child, ctx);
}

export async function consumeCursorStream(
  child: ChildProcessWithoutNullStreams,
  ctx: WorkerSdkContext
): Promise<{ resultSummary?: string; providerThreadId?: string }> {
  let stdout = '';
  let stderr = '';
  let resultSummary = '';
  let providerThreadId = ctx.providerThreadId;
  let sawResult = false;
  let settled = false;
  const abort = () => child.kill();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    return await new Promise((resolve, reject) => {
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(error);
      };
      child.once('error', fail);
      child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, String(chunk), MAX_CAPTURE_BYTES); });
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > MAX_CAPTURE_BYTES) return fail(new Error('Cursor output exceeded 512 KiB'));
        const lines = stdout.split(/\r?\n/u);
        stdout = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const normalized = normalizeCursorStreamEvent(JSON.parse(line));
            providerThreadId = normalized.sessionId ?? providerThreadId;
            if (normalized.text) resultSummary = normalized.text;
            if (normalized.kind === 'completion') sawResult = true;
            emitNormalized(ctx, normalized, providerThreadId);
          } catch {
            // Nonzero exit plus stderr is Cursor's documented failure contract.
          }
        }
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (ctx.signal.aborted) return resolve({ resultSummary: 'Cursor interrupted', providerThreadId });
        if (code !== 0) return reject(new Error(stderr.trim() || `Cursor exited with ${signal ?? `code ${code}`}`));
        if (!sawResult) return reject(new Error('Cursor stream ended without a result event'));
        resolve({ resultSummary: resultSummary || 'Cursor completed', providerThreadId });
      });
    });
  } finally {
    ctx.signal.removeEventListener('abort', abort);
  }
}

function emitNormalized(
  ctx: WorkerSdkContext,
  normalized: NormalizedCursorEvent,
  providerThreadId = normalized.sessionId
): void {
  if (normalized.kind === 'unknown') return;
  const label = `Cursor ${normalized.kind.replaceAll('_', ' ')}`;
  const toolEvent = normalized.kind === 'tool_call'
    || normalized.kind === 'tool_result'
    || normalized.kind === 'file_change'
    || normalized.kind === 'command';
  ctx.emit({
    state: normalized.state,
    summary: normalized.text && toolEvent ? `${label}: ${normalized.text}` : normalized.text ?? label,
    ...(normalized.toolCallId ? { detail: `tool call ${normalized.toolCallId}` } : {}),
    providerThreadId
  });
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  return next.length <= maxBytes ? next : next.slice(-maxBytes);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isUnsupportedAcp(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('acp') && (
    message.includes('unknown command')
    || message.includes('unrecognized command')
    || message.includes('unrecognized subcommand')
    || message.includes('invalid command')
  );
}
