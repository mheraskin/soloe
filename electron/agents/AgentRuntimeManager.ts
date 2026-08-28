import { randomBytes } from 'node:crypto';
import type {
  CreateWorkerSessionRequest,
  CreateWorkerSessionResult,
  ObservedAgentSnapshot,
  SendWorkerPromptRequest,
  WorkerAgentProvider,
  WorkerStatusResult
} from '@shared/types/agents.js';
import type { AgentObservedState, SessionId } from '@shared/types/sessions.js';
import type { AgentObserverManager } from './AgentObserverManager.js';

export interface WorkerSdkEvent {
  state?: AgentObservedState;
  summary: string;
  detail?: string;
  providerThreadId?: string;
  transcriptPath?: string;
}

export interface WorkerSdkContext {
  workerId: string;
  provider: WorkerAgentProvider;
  cwd?: string;
  signal: AbortSignal;
  providerThreadId?: string;
  autoApprovesPermissions: boolean;
  emit(event: WorkerSdkEvent): void;
}

export interface WorkerSdkAdapter {
  run(prompt: string, ctx: WorkerSdkContext): Promise<{ resultSummary?: string; providerThreadId?: string }>;
}

export interface AgentRuntimeManagerOptions {
  observer: AgentObserverManager;
  sdkLoader?: (provider: WorkerAgentProvider) => Promise<WorkerSdkAdapter>;
  autoApprovesPermissions?: (originSessionId: SessionId) => Promise<boolean> | boolean;
  getCursorBinary?: () => Promise<string | undefined> | string | undefined;
}

interface WorkerRecord {
  workerId: string;
  provider: WorkerAgentProvider;
  originSessionId: string;
  cwd?: string;
  abort?: AbortController;
  running?: Promise<void>;
  adapter?: WorkerSdkAdapter;
  providerThreadId?: string;
}

export class AgentRuntimeManager {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly sdkLoader: (provider: WorkerAgentProvider) => Promise<WorkerSdkAdapter>;

  constructor(private readonly opts: AgentRuntimeManagerOptions) {
    this.sdkLoader = opts.sdkLoader ?? ((provider) => loadDefaultSdkAdapter(provider, opts.getCursorBinary));
  }

  createWorkerSession(request: CreateWorkerSessionRequest): CreateWorkerSessionResult {
    const workerId = newWorkerId(request.provider);
    const record: WorkerRecord = {
      workerId,
      provider: request.provider,
      originSessionId: request.originSessionId,
      cwd: request.cwd
    };
    this.workers.set(workerId, record);
    const snapshot = this.opts.observer.registerWorker({
      workerId,
      originSessionId: request.originSessionId,
      provider: request.provider,
      promptSummary: request.promptSummary
    });
    return { workerId, snapshot };
  }

  async sendWorkerPrompt(request: SendWorkerPromptRequest): Promise<WorkerStatusResult> {
    const record = this.requireWorker(request.workerId);
    if (record.running) {
      throw new Error(`Worker is already running: ${request.workerId}`);
    }
    const abort = new AbortController();
    record.abort = abort;

    const autoApprovesPermissions = await Promise.resolve(
      this.opts.autoApprovesPermissions?.(record.originSessionId) ?? false
    ).catch(() => false);

    const promptSummary = summarizePrompt(request.prompt);
    this.patchWorker(record.workerId, {
      state: 'working',
      promptSummary,
      resultSummary: undefined,
      error: undefined,
      autoApprovesPermissions,
      confidence: 0.6
    }, 'prompt received');

    const runPromise = this.runWorker(record, request.prompt, abort, autoApprovesPermissions);
    record.running = runPromise;
    runPromise.finally(() => {
      if (record.running === runPromise) record.running = undefined;
      if (record.abort === abort) record.abort = undefined;
    }).catch(() => {});

    return { snapshot: this.opts.observer.getSnapshot(record.workerId) };
  }

  getWorkerStatus(workerId: string): WorkerStatusResult {
    return { snapshot: this.opts.observer.getSnapshot(workerId) };
  }

  async stopWorkerSession(workerId: string): Promise<WorkerStatusResult> {
    const record = this.requireWorker(workerId);
    record.abort?.abort();
    await record.running?.catch(() => {});
    const snapshot = this.patchWorker(workerId, {
      state: 'exited',
      resultSummary: 'worker stopped',
      confidence: 0.8
    }, 'worker stopped');
    return { snapshot };
  }

  async dispose(): Promise<void> {
    const running = [...this.workers.values()].map(async (worker) => {
      worker.abort?.abort();
      await worker.running?.catch(() => {});
    });
    await Promise.all(running);
    this.workers.clear();
  }

  private async runWorker(
    record: WorkerRecord,
    prompt: string,
    abort: AbortController,
    autoApprovesPermissions: boolean
  ): Promise<void> {
    try {
      const adapter = record.adapter ?? await this.sdkLoader(record.provider);
      record.adapter = adapter;
      if (abort.signal.aborted) return;
      const result = await adapter.run(prompt, {
        workerId: record.workerId,
        provider: record.provider,
        cwd: record.cwd,
        signal: abort.signal,
        providerThreadId: record.providerThreadId,
        autoApprovesPermissions,
        emit: (event) => {
          const state = event.state ?? 'working';
          this.patchWorker(record.workerId, {
            state,
            providerThreadId: event.providerThreadId,
            transcriptPath: event.transcriptPath
          }, event.summary, event.detail);
        }
      });
      if (abort.signal.aborted) return;
      record.providerThreadId = result.providerThreadId ?? record.providerThreadId;
      this.patchWorker(record.workerId, {
        state: 'completed',
        resultSummary: result.resultSummary ?? 'worker completed',
        providerThreadId: result.providerThreadId,
        confidence: 0.9
      }, result.resultSummary ?? 'worker completed');
    } catch (err) {
      if (abort.signal.aborted) return;
      const message = errorMessage(err);
      this.patchWorker(record.workerId, {
        state: 'failed',
        error: message,
        resultSummary: message,
        confidence: 0.9
      }, 'worker failed', message);
    }
  }

  private requireWorker(workerId: string): WorkerRecord {
    const record = this.workers.get(workerId);
    if (!record) throw new Error(`Worker not found: ${workerId}`);
    return record;
  }

  private patchWorker(
    workerId: string,
    patch: Partial<ObservedAgentSnapshot>,
    eventSummary?: string,
    detail?: string
  ): ObservedAgentSnapshot {
    return this.opts.observer.updateWorker(
      workerId,
      patch,
      eventSummary ? { summary: eventSummary, detail } : undefined
    );
  }
}

async function loadDefaultSdkAdapter(
  provider: WorkerAgentProvider,
  getCursorBinary?: AgentRuntimeManagerOptions['getCursorBinary']
): Promise<WorkerSdkAdapter> {
  if (provider === 'cursor') {
    const { createCursorWorkerAdapter } = await import('./CursorWorkerAdapter.js');
    return createCursorWorkerAdapter({ getBinary: getCursorBinary });
  }
  const packageName = provider === 'claude_code'
    ? '@anthropic-ai/claude-code'
    : '@openai/codex-sdk';
  const mod = await importOptional(packageName).catch((err) => {
    throw new Error(`${packageName} is not available: ${errorMessage(err)}`);
  });
  return makeGenericAdapter(packageName, mod);
}

function makeGenericAdapter(packageName: string, mod: unknown): WorkerSdkAdapter {
  return {
    async run(prompt, ctx) {
      const api = mod as Record<string, unknown>;
      const runner = firstFunction(api, ['query', 'run', 'execute']);
      if (runner) {
        const result = await runner({ prompt, cwd: ctx.cwd, signal: ctx.signal });
        return await consumeSdkResult(result, ctx);
      }
      const ctor = firstConstructor(api, ['Codex', 'Client', 'ClaudeCode']);
      if (ctor) {
        const client = new ctor({ cwd: ctx.cwd });
        const method = firstFunction(client as Record<string, unknown>, ['query', 'run', 'execute']);
        if (method) {
          const result = await method.call(client, { prompt, signal: ctx.signal });
          return await consumeSdkResult(result, ctx);
        }
      }
      throw new Error(`${packageName} does not expose a supported worker runner`);
    }
  };
}

async function consumeSdkResult(
  result: unknown,
  ctx: WorkerSdkContext
): Promise<{ resultSummary?: string; providerThreadId?: string }> {
  if (isAsyncIterable(result)) {
    let lastSummary = 'worker completed';
    let providerThreadId: string | undefined;
    for await (const event of result) {
      if (ctx.signal.aborted) break;
      const normalized = normalizeSdkEvent(event);
      lastSummary = normalized.summary;
      providerThreadId = normalized.providerThreadId ?? providerThreadId;
      ctx.emit(normalized);
    }
    return { resultSummary: lastSummary, providerThreadId };
  }
  if (typeof result === 'string') return { resultSummary: summarizePrompt(result) };
  if (isRecord(result)) {
    const summary = stringField(result, ['summary', 'result', 'text', 'message']);
    const providerThreadId = stringField(result, ['threadId', 'sessionId', 'conversationId', 'id']);
    return { resultSummary: summary ?? 'worker completed', providerThreadId };
  }
  return { resultSummary: 'worker completed' };
}

export function normalizeSdkEvent(event: unknown): WorkerSdkEvent {
  if (!isRecord(event)) return { state: 'working', summary: String(event) };
  const rawType = stringField(event, ['type', 'event', 'kind', 'status']) ?? 'event';
  const state = stateFromSdkType(rawType);
  const summary =
    stringField(event, ['summary', 'message', 'text', 'content', 'name']) ?? rawType;
  return {
    state,
    summary: summarizePrompt(summary),
    detail: stringField(event, ['detail', 'error']),
    providerThreadId: stringField(event, ['threadId', 'sessionId', 'conversationId', 'id']),
    transcriptPath: stringField(event, ['transcriptPath', 'logPath'])
  };
}

export function stateFromSdkType(type: string): AgentObservedState {
  const lower = type.toLowerCase();
  if (lower.includes('tool')) return 'running_tool';
  if (lower.includes('approval')) return 'waiting_for_approval';
  if (lower.includes('input')) return 'waiting_for_input';
  if (lower.includes('complete') || lower.includes('done') || lower.includes('result')) return 'completed';
  if (lower.includes('fail') || lower.includes('error')) return 'failed';
  if (lower.includes('start')) return 'starting';
  return 'working';
}

function newWorkerId(provider: WorkerAgentProvider): string {
  const prefix = provider === 'claude_code'
    ? 'claude-worker'
    : provider === 'codex' ? 'codex-worker' : 'cursor-worker';
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function summarizePrompt(input: string, max = 180): string {
  const compact = input.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

async function importOptional(specifier: string): Promise<unknown> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    value: string
  ) => Promise<unknown>;
  return dynamicImport(specifier);
}

function firstFunction(source: Record<string, unknown>, names: string[]): Function | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'function') return value;
  }
  return null;
}

function firstConstructor(
  source: Record<string, unknown>,
  names: string[]
): (new (...args: unknown[]) => unknown) | null {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'function') {
      return value as new (...args: unknown[]) => unknown;
    }
  }
  return null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return isRecord(value) && typeof value[Symbol.asyncIterator] === 'function';
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(source: Record<PropertyKey, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
