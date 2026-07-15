import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentObserverManager } from './AgentObserverManager.js';
import {
  AgentObserverStore,
  type ObserverPersistenceAdapter
} from './AgentObserverStore.js';
import { detectUsageLimit } from './UsageLimitDetector.js';
import type { Session } from '@shared/types/sessions.js';

describe('AgentObserverStore', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'soloe-observer-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('persists TUI usage-limit snapshots for app reload', async () => {
    const file = join(tmp, 'observer.json');
    const observer = new AgentObserverManager();
    const usageLimit = detectUsageLimit(
      "You've hit your usage limit. Try again at Apr 13th, 2026 12:46 AM."
    );
    expect(usageLimit).not.toBeNull();
    observer.setTuiUsageLimit('sess-1', {
      ...usageLimit!,
      detectedAt: '2026-04-12T14:07:47.435Z'
    });

    await new AgentObserverStore(file).persist(observer);

    const restored = await new AgentObserverStore(file).load();
    expect(restored.snapshots).toHaveLength(1);
    expect(restored.snapshots[0]).toMatchObject({
      id: 'sess-1',
      runtimeMode: 'tui',
      subjectKind: 'session',
      state: 'usage_limited',
      usageLimit: { resetAtLabel: 'Apr 13th, 2026 12:46 AM' }
    });
    expect(restored.events.some((event) => event.state === 'usage_limited')).toBe(true);
  });

  it('drops stale TUI usage-limit snapshots from older detector versions', async () => {
    const file = join(tmp, 'observer.json');
    const observer = new AgentObserverManager();
    observer.setTuiUsageLimit('sess-1', {
      message: 'usage/rate limit reached/exceeded, never quota status lines',
      detectedAt: '2026-04-12T14:07:47.435Z'
    });

    await new AgentObserverStore(file).persist(observer);

    const restored = await new AgentObserverStore(file).load();
    expect(restored.snapshots).toHaveLength(0);
  });

  it('performs no writes for many ordinary TUI registrations and status changes', async () => {
    const persistence = new FakeObserverPersistence();
    const store = new AgentObserverStore('/unused/observer.json', persistence);
    await store.load();
    const observer = new AgentObserverManager();
    store.attach(observer);

    for (let index = 0; index < 20; index += 1) {
      const current = tuiSession(`session-${index}`);
      observer.registerTuiSession(current);
      observer.updateTuiStatus({
        sessionId: current.id,
        terminalId: `terminal-${index}`,
        status: 'running'
      });
    }
    await store.flush();

    expect(persistence.writes).toEqual([]);
    await store.dispose();
  });

  it('coalesces one usage-limit mutation into one durable replacement', async () => {
    const persistence = new FakeObserverPersistence();
    const store = new AgentObserverStore('/unused/observer.json', persistence);
    await store.load();
    const observer = new AgentObserverManager();
    store.attach(observer);

    observer.setTuiUsageLimit('session-1', currentUsageLimit());
    await store.flush();

    expect(persistence.writes).toHaveLength(1);
    const written = JSON.parse(persistence.writes[0] ?? '{}') as {
      snapshots?: Array<{ state?: string }>;
      events?: Array<{ state?: string }>;
    };
    expect(written.snapshots?.map((snapshot) => snapshot.state)).toEqual(['usage_limited']);
    expect(written.events?.map((event) => event.state)).toEqual(['usage_limited']);
    await store.dispose();
  });

  it('keeps one in-flight write and one latest follow-up during an event burst', async () => {
    const persistence = new FakeObserverPersistence();
    const blocked = persistence.blockNextWrite();
    const store = new AgentObserverStore('/unused/observer.json', persistence);
    await store.load();
    const observer = new AgentObserverManager();
    store.attach(observer);

    observer.registerWorker({
      workerId: 'worker-1',
      originSessionId: 'session-1',
      provider: 'codex'
    });
    await blocked.started;
    for (let index = 0; index < 100; index += 1) {
      observer.updateWorker('worker-1', { resultSummary: `revision-${index}` });
    }
    blocked.release();
    await store.flush();

    expect(persistence.maxConcurrentWrites).toBe(1);
    expect(persistence.writes).toHaveLength(2);
    expect(persistence.writes.at(-1)).toContain('revision-99');
    await store.dispose();
  });

  it('recovers after a failed atomic replacement instead of poisoning later writes', async () => {
    const persistence = new FakeObserverPersistence();
    persistence.failNextWrite = new Error('disk temporarily unavailable');
    const store = new AgentObserverStore('/unused/observer.json', persistence);
    await store.load();
    const observer = new AgentObserverManager();
    store.attach(observer);

    observer.setTuiUsageLimit('session-1', currentUsageLimit());
    await expect(store.flush()).rejects.toThrow('disk temporarily unavailable');

    observer.setTuiUsageLimit('session-1', {
      ...currentUsageLimit(),
      detectedAt: '2026-07-14T10:00:00.000Z'
    });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(persistence.writes).toHaveLength(2);
    expect(persistence.successfulWrites).toHaveLength(1);
    expect(persistence.successfulWrites[0]).toContain('2026-07-14T10:00:00.000Z');
    await store.dispose();
  });

  it('persists deletion without waiting for an unrelated observer transition', async () => {
    const persistence = new FakeObserverPersistence();
    const store = new AgentObserverStore('/unused/observer.json', persistence);
    await store.load();
    const observer = new AgentObserverManager();
    store.attach(observer);
    observer.setTuiUsageLimit('session-1', currentUsageLimit());
    await store.flush();

    observer.removeSession('session-1');
    await store.flush();

    expect(persistence.writes).toHaveLength(2);
    const finalState = JSON.parse(persistence.writes.at(-1) ?? '{}') as {
      snapshots?: unknown[];
      events?: unknown[];
    };
    expect(finalState.snapshots).toEqual([]);
    expect(finalState.events).toEqual([]);
    await store.dispose();
  });

  it('disposal waits for the latest projection when a write is already running', async () => {
    const persistence = new FakeObserverPersistence();
    const blocked = persistence.blockNextWrite();
    const store = new AgentObserverStore('/unused/observer.json', persistence);
    await store.load();
    const observer = new AgentObserverManager();
    store.attach(observer);
    observer.registerWorker({
      workerId: 'worker-1',
      originSessionId: 'session-1',
      provider: 'claude_code'
    });
    await blocked.started;
    observer.updateWorker('worker-1', { resultSummary: 'latest-before-shutdown' });

    const disposing = store.dispose();
    blocked.release();
    await disposing;

    expect(persistence.writes).toHaveLength(2);
    expect(persistence.successfulWrites.at(-1)).toContain('latest-before-shutdown');
  });

  it('retries one transient replacement failure during final disposal', async () => {
    const persistence = new FakeObserverPersistence();
    persistence.failNextWrite = new Error('temporary file lock');
    const store = new AgentObserverStore('/unused/observer.json', persistence);
    await store.load();
    const observer = new AgentObserverManager();
    store.attach(observer);
    observer.setTuiUsageLimit('session-1', currentUsageLimit());

    await expect(store.dispose()).resolves.toBeUndefined();

    expect(persistence.writes).toHaveLength(2);
    expect(persistence.successfulWrites).toHaveLength(1);
  });
});

class FakeObserverPersistence implements ObserverPersistenceAdapter {
  readonly writes: string[] = [];
  readonly successfulWrites: string[] = [];
  failNextWrite: Error | null = null;
  maxConcurrentWrites = 0;
  private concurrentWrites = 0;
  private nextBlock: Deferred<void> | null = null;
  private nextStarted: (() => void) | null = null;

  async read(): Promise<string | null> {
    return null;
  }

  async writeAtomic(content: string): Promise<void> {
    this.writes.push(content);
    this.concurrentWrites += 1;
    this.maxConcurrentWrites = Math.max(this.maxConcurrentWrites, this.concurrentWrites);
    const block = this.nextBlock;
    this.nextBlock = null;
    this.nextStarted?.();
    this.nextStarted = null;
    try {
      if (block) await block.promise;
      const failure = this.failNextWrite;
      this.failNextWrite = null;
      if (failure) throw failure;
      this.successfulWrites.push(content);
    } finally {
      this.concurrentWrites -= 1;
    }
  }

  blockNextWrite(): { started: Promise<void>; release: () => void } {
    const block = deferred<void>();
    const started = deferred<void>();
    this.nextBlock = block;
    this.nextStarted = () => started.resolve(undefined);
    return { started: started.promise, release: () => block.resolve(undefined) };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tuiSession(id: string): Session {
  return {
    id,
    launch: { type: 'terminal', shell: 'auto' },
    name: id,
    cwd: `/worktrees/${id}`,
    runMode: 'windows',
    createdAt: '2026-07-14T00:00:00.000Z',
    lastUsedAt: '2026-07-14T00:00:00.000Z'
  };
}

function currentUsageLimit() {
  const usageLimit = detectUsageLimit(
    "You've hit your usage limit. Try again at Jul 15th, 2026 12:00 AM."
  );
  if (!usageLimit) throw new Error('Expected usage-limit fixture to match');
  return { ...usageLimit, detectedAt: '2026-07-14T09:00:00.000Z' };
}
