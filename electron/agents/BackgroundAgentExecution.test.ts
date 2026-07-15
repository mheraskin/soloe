import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundAgentExecution, type BackgroundAgentRequest } from './BackgroundAgentExecution.js';

const request = (overrides: Partial<BackgroundAgentRequest> = {}): BackgroundAgentRequest => ({
  candidates: [{ provider: 'codex', id: 'gpt-5.4-mini' }],
  binaries: {},
  scope: { cwd: '/repo', runMode: 'windows' },
  prompt: 'summarize',
  timeoutMs: 1_000,
  priority: 'background',
  ...overrides
});

describe('BackgroundAgentExecution', () => {
  it('falls back to the first executable that is actually available', async () => {
    const child = new FakeChild();
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => child);
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async (executable) => executable === '/opt/claude'
    });
    const pending = execution.execute(request({
      candidates: [
        { provider: 'codex', id: 'gpt-5.4-mini' },
        { provider: 'claude', id: 'haiku' }
      ],
      binaries: { codex: '/missing/codex', claude: '/opt/claude' }
    }));
    await waitFor(() => spawnMock.mock.calls.length === 1);

    expect(spawnMock.mock.calls[0]?.[0]).toBe('/opt/claude');
    child.succeed('fallback result');
    await expect(pending).resolves.toEqual({
      ok: true,
      text: 'fallback result',
      provider: { provider: 'claude', id: 'haiku' }
    });
  });

  it('serializes background work while leaving capacity for interactive work', async () => {
    const children: FakeChild[] = [];
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async () => true,
      maxConcurrency: 2,
      maxBackgroundConcurrency: 1
    });

    const first = execution.execute(request({ prompt: 'first' }));
    const second = execution.execute(request({ prompt: 'second' }));
    await waitFor(() => children.length === 1);
    const interactive = execution.execute(request({ prompt: 'interactive', priority: 'interactive' }));
    await waitFor(() => children.length === 2);
    expect(children).toHaveLength(2);

    children[1]!.succeed('interactive');
    await interactive;
    expect(children).toHaveLength(2);
    children[0]!.succeed('first');
    await first;
    await waitFor(() => children.length === 3);
    children[2]!.succeed('second');
    await second;
  });

  it('drops stale queued work before spawning a process', async () => {
    const firstChild = new FakeChild();
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => firstChild);
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async () => true,
      maxConcurrency: 1,
      maxBackgroundConcurrency: 1
    });
    const first = execution.execute(request());
    await waitFor(() => spawnMock.mock.calls.length === 1);
    const stale = execution.execute(request({ validate: async () => false }));

    firstChild.succeed('first');
    await first;
    await expect(stale).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable without launching a model process', async () => {
    const spawnMock = vi.fn();
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async () => false
    });

    await expect(execution.execute(request())).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable'
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('kills a streaming child and releases admission when the consumer cancels', async () => {
    const children: FakeChild[] = [];
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async () => true,
      maxConcurrency: 1
    });
    const stream = execution.stream(request({ priority: 'interactive' }))[Symbol.asyncIterator]();
    const firstChunk = stream.next();
    await waitFor(() => children.length === 1);
    children[0]!.stdout.write('partial');
    await expect(firstChunk).resolves.toEqual({
      done: false,
      value: { type: 'delta', text: 'partial' }
    });

    await stream.return?.();
    expect(children[0]!.killed).toBe(true);

    const next = execution.execute(request({ priority: 'interactive' }));
    await waitFor(() => children.length === 2);
    children[1]!.succeed('next');
    await expect(next).resolves.toMatchObject({ ok: true, text: 'next' });
  });

  it('aborts an active one-shot child without waiting for close and releases admission', async () => {
    const children: FakeChild[] = [];
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async () => true,
      maxConcurrency: 1
    });
    const controller = new AbortController();
    const aborted = execution.execute(request({
      priority: 'interactive',
      signal: controller.signal
    }));
    await waitFor(() => children.length === 1);

    controller.abort();

    await expect(aborted).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(children[0]!.killed).toBe(true);

    const next = execution.execute(request({ priority: 'interactive' }));
    await waitFor(() => children.length === 2);
    children[1]!.succeed('next');
    await expect(next).resolves.toMatchObject({ ok: true, text: 'next' });
  });

  it('removes an aborted queued request without consuming a later permit', async () => {
    const children: FakeChild[] = [];
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async () => true,
      maxConcurrency: 1
    });
    const first = execution.execute(request({ priority: 'interactive' }));
    await waitFor(() => children.length === 1);
    const controller = new AbortController();
    const queued = execution.execute(request({
      priority: 'interactive',
      signal: controller.signal
    }));

    controller.abort();

    await expect(queued).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(children).toHaveLength(1);
    children[0]!.succeed('first');
    await first;

    const next = execution.execute(request({ priority: 'interactive' }));
    await waitFor(() => children.length === 2);
    children[1]!.succeed('next');
    await expect(next).resolves.toMatchObject({ ok: true, text: 'next' });
  });

  it('aborts an active stream through its signal and releases admission', async () => {
    const children: FakeChild[] = [];
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async () => true,
      maxConcurrency: 1
    });
    const controller = new AbortController();
    const stream = execution.stream(request({
      priority: 'interactive',
      signal: controller.signal
    }))[Symbol.asyncIterator]();
    const pending = stream.next();
    await waitFor(() => children.length === 1);

    controller.abort();

    await expect(pending).resolves.toEqual({
      done: false,
      value: { type: 'error', error: 'Background agent request was cancelled.' }
    });
    expect(children[0]!.killed).toBe(true);
    await stream.return?.();

    const next = execution.execute(request({ priority: 'interactive' }));
    await waitFor(() => children.length === 2);
    children[1]!.succeed('next');
    await expect(next).resolves.toMatchObject({ ok: true, text: 'next' });
  });

  it('disposes active and queued requests without waiting for child close', async () => {
    const child = new FakeChild();
    const spawnMock = vi.fn((..._args: Parameters<typeof spawn>) => child);
    const execution = new BackgroundAgentExecution({
      spawnImpl: spawnMock as unknown as typeof spawn,
      isExecutableAvailable: async () => true,
      maxConcurrency: 1
    });
    const active = execution.execute(request({ priority: 'interactive' }));
    await waitFor(() => spawnMock.mock.calls.length === 1);
    const queued = execution.execute(request({ priority: 'interactive' }));

    await execution.dispose();

    await expect(active).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    await expect(queued).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(child.killed).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(execution.execute(request())).resolves.toMatchObject({
      ok: false,
      reason: 'cancelled'
    });
  });
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  succeed(output: string): void {
    this.stdout.end(output);
    this.stderr.end();
    this.emit('close', 0);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for predicate');
}
