import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkerSdkContext } from './AgentRuntimeManager.js';
import { consumeCursorStream, CursorAcpClient } from './CursorWorkerAdapter.js';

type Listener = (value: unknown) => void;

class FakeTransport {
  readonly sent: Record<string, unknown>[] = [];
  respondToInitialize = true;
  respondToPrompt = true;
  private promptId?: number;
  private message?: Listener;
  private closeListener?: (error?: Error) => void;

  send = (value: Record<string, unknown>): void => {
    this.sent.push(value);
    const method = value.method;
    const id = value.id;
    if (method === 'session/cancel' && this.promptId !== undefined) {
      queueMicrotask(() => this.reply(this.promptId!, { stopReason: 'cancelled' }));
      return;
    }
    if (typeof id !== 'number') return;
    queueMicrotask(() => {
      if (method === 'initialize' && this.respondToInitialize) this.reply(id, {});
      if (method === 'session/new') this.reply(id, { sessionId: 'cursor-session-1' });
      if (method === 'session/load') this.reply(id, {});
      if (method === 'session/prompt') {
        this.promptId = id;
        if (this.respondToPrompt) this.reply(id, { stopReason: 'end_turn' });
      }
    });
  };
  close = vi.fn(() => this.closeListener?.(new Error('transport closed')));
  onMessage = (listener: Listener): (() => void) => { this.message = listener; return () => {}; };
  onClose = (listener: (error?: Error) => void): (() => void) => {
    this.closeListener = listener;
    return () => {};
  };
  emit(value: unknown): void { this.message?.(value); }
  reply(id: number, result: unknown): void { this.emit({ jsonrpc: '2.0', id, result }); }
}

function context(patch: Partial<WorkerSdkContext> = {}): WorkerSdkContext {
  return {
    workerId: 'worker-1',
    provider: 'cursor',
    cwd: '/repo',
    signal: new AbortController().signal,
    autoApprovesPermissions: false,
    emit: vi.fn(),
    ...patch
  };
}

describe('CursorAcpClient', () => {
  it('initializes, creates a session, and prompts with typed content', async () => {
    const transport = new FakeTransport();
    const ctx = context();
    const client = new CursorAcpClient(transport, ctx);

    await expect(client.run('fix it')).resolves.toEqual({
      resultSummary: 'Cursor completed', providerThreadId: 'cursor-session-1'
    });
    expect(transport.sent.map((message) => message.method)).toEqual([
      'initialize', 'session/new', 'session/prompt'
    ]);
    expect(transport.sent[2]?.params).toMatchObject({
      sessionId: 'cursor-session-1', prompt: [{ type: 'text', text: 'fix it' }]
    });
    client.dispose();
  });

  it('loads the persisted ACP session for subsequent prompts', async () => {
    const transport = new FakeTransport();
    const client = new CursorAcpClient(transport, context({ providerThreadId: 'existing-chat' }));

    await client.run('continue');
    expect(transport.sent[1]).toMatchObject({
      method: 'session/load', params: { sessionId: 'existing-chat', cwd: '/repo', mcpServers: [] }
    });
    client.dispose();
  });

  it('answers permission requests according to Soloe approval mode', async () => {
    const transport = new FakeTransport();
    const emit = vi.fn();
    const client = new CursorAcpClient(transport, context({ autoApprovesPermissions: true, emit }));

    transport.emit({
      jsonrpc: '2.0', id: 99, method: 'session/request_permission',
      params: { sessionId: 's', options: [{ optionId: 'allow-once', name: 'Allow once' }] }
    });
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: '2.0', id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ state: 'waiting_for_approval' }));
    client.dispose();
  });

  it('sends ACP cancellation when Soloe stops a worker', async () => {
    const transport = new FakeTransport();
    transport.respondToPrompt = false;
    const controller = new AbortController();
    const client = new CursorAcpClient(transport, context({ signal: controller.signal }));
    const run = client.run('wait');
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await run;
    expect(transport.sent).toContainEqual({
      jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'cursor-session-1' }
    });
    client.dispose();
  });

  it('aborts a hung ACP handshake immediately', async () => {
    const transport = new FakeTransport();
    transport.respondToInitialize = false;
    const controller = new AbortController();
    const client = new CursorAcpClient(transport, context({ signal: controller.signal }));
    const run = client.run('wait');
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(run).rejects.toThrow('transport closed');
    expect(transport.close).toHaveBeenCalled();
    client.dispose();
  });
});

describe('Cursor stream fallback', () => {
  it('requires Cursor\'s documented terminal result event', async () => {
    const child = fakeChild();
    const result = consumeCursorStream(child.process, context());
    child.stdout.write('{malformed}\n');
    child.close(0);
    await expect(result).rejects.toThrow('without a result event');
  });

  it('captures session identity and the canonical result', async () => {
    const child = fakeChild();
    const result = consumeCursorStream(child.process, context());
    child.stdout.write(`${JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'stream-session'
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'done', session_id: 'stream-session'
    })}\n`);
    child.close(0);
    await expect(result).resolves.toEqual({
      resultSummary: 'done', providerThreadId: 'stream-session'
    });
  });
});

function fakeChild(): {
  process: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  close(code: number): void;
} {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  Object.assign(process, {
    stdout,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn()
  });
  return {
    process,
    stdout,
    close(code) { process.emit('close', code, null); }
  };
}
