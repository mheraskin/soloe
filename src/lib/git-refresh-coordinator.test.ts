import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitRefreshCoordinator } from './git-refresh-coordinator';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('GitRefreshCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never overlaps a worktree whose refresh exceeds its cadence', async () => {
    const requests: ReturnType<typeof deferred>[] = [];
    const refresh = vi.fn(() => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    });
    const coordinator = new GitRefreshCoordinator(refresh, {
      intervals: { foreground: 100, background: 1_000 },
      jitterRatio: 0
    });
    coordinator.reconcile([{ key: '/repo', cadence: 'foreground', eager: true }]);

    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh).toHaveBeenCalledTimes(1);

    requests[0]!.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(99);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('caps global concurrency and starts foreground worktrees before background ones', async () => {
    const requests = new Map<string, ReturnType<typeof deferred>>();
    let active = 0;
    let maxActive = 0;
    const starts: string[] = [];
    const coordinator = new GitRefreshCoordinator(async (key) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(key);
      const request = deferred();
      requests.set(key, request);
      await request.promise;
      active -= 1;
    }, {
      intervals: { foreground: 100, background: 1_000 },
      maxConcurrency: 2,
      jitterRatio: 0
    });
    coordinator.reconcile([
      { key: '/slow-a', cadence: 'background', eager: true },
      { key: '/fast-a', cadence: 'foreground', eager: true },
      { key: '/slow-b', cadence: 'background', eager: true },
      { key: '/fast-b', cadence: 'foreground', eager: true }
    ]);

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(['/fast-a', '/fast-b']);
    expect(maxActive).toBe(2);

    requests.get('/fast-a')!.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(['/fast-a', '/fast-b', '/slow-a']);
    expect(maxActive).toBe(2);
    coordinator.dispose();
  });

  it('allows only one WSL observation per distro while using other capacity', async () => {
    const requests = new Map<string, ReturnType<typeof deferred>>();
    const starts: string[] = [];
    const coordinator = new GitRefreshCoordinator(async (key) => {
      starts.push(key);
      const request = deferred();
      requests.set(key, request);
      await request.promise;
    }, {
      intervals: { foreground: 100, background: 1_000 },
      maxConcurrency: 3,
      maxPerGroup: 1,
      jitterRatio: 0
    });
    coordinator.reconcile([
      { key: '/ubuntu-a', cadence: 'foreground', eager: true, group: 'wsl:Ubuntu' },
      { key: '/ubuntu-b', cadence: 'foreground', eager: true, group: 'wsl:Ubuntu' },
      { key: '/debian', cadence: 'foreground', eager: true, group: 'wsl:Debian' },
      { key: '/native', cadence: 'foreground', eager: true }
    ]);

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(['/ubuntu-a', '/debian', '/native']);
    requests.get('/ubuntu-a')!.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toContain('/ubuntu-b');
    coordinator.dispose();
  });

  it('collapses repeated invalidations during a refresh into one follow-up', async () => {
    const requests: ReturnType<typeof deferred>[] = [];
    const refresh = vi.fn(() => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    });
    const coordinator = new GitRefreshCoordinator(refresh, {
      intervals: { foreground: 100, background: 1_000 },
      jitterRatio: 0
    });
    coordinator.reconcile([{ key: '/repo', cadence: 'foreground', eager: true }]);
    await vi.advanceTimersByTimeAsync(0);

    coordinator.request('/repo', { kind: 'filesystem', occurredAt: 1 });
    coordinator.request('/repo', { kind: 'filesystem', occurredAt: 2 });
    coordinator.request('/repo', { kind: 'filesystem', occurredAt: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    requests[0]!.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    requests[1]!.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('resumes foreground work immediately without stampeding background worktrees', async () => {
    const refresh = vi.fn(async (_key: string) => undefined);
    const coordinator = new GitRefreshCoordinator(refresh, {
      intervals: { foreground: 100, background: 1_000 },
      jitterRatio: 0
    });
    coordinator.reconcile([
      { key: '/fast', cadence: 'foreground', eager: true },
      { key: '/slow-a', cadence: 'background', eager: true },
      { key: '/slow-b', cadence: 'background', eager: true }
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    refresh.mockClear();

    coordinator.setPollingPaused(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).not.toHaveBeenCalled();
    coordinator.setPollingPaused(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(['/fast']);
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh.mock.calls.every(([key]) => key === '/fast')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh.mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining(['/slow-a', '/slow-b'])
    );
    coordinator.dispose();
  });

  it('keeps its deadline when equal intents are reconciled', async () => {
    const refresh = vi.fn(async (_key: string) => undefined);
    const coordinator = new GitRefreshCoordinator(refresh, {
      intervals: { foreground: 100, background: 1_000 },
      jitterRatio: 0
    });
    coordinator.reconcile([{ key: '/repo', cadence: 'foreground', eager: true }]);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    coordinator.reconcile([{ key: '/repo', cadence: 'foreground', eager: true }]);
    await vi.advanceTimersByTimeAsync(49);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it('drops an old-context completion and publishes only its follow-up', async () => {
    const requests: Array<{ context: string | undefined; request: ReturnType<typeof deferred> }> = [];
    const coordinator = new GitRefreshCoordinator<string, string>(async (_key, context) => {
      const request = deferred();
      requests.push({ context, request });
      await request.promise;
      return context ?? 'missing';
    }, {
      intervals: { foreground: 100, background: 1_000 },
      jitterRatio: 0
    });
    const events: Array<{ result: string; cause: string }> = [];
    coordinator.subscribe((event) => events.push({ result: event.result, cause: event.cause.kind }));
    coordinator.reconcile([{
      key: '/repo', cadence: 'foreground', eager: true, context: 'old', contextId: 'old'
    }]);
    await vi.advanceTimersByTimeAsync(0);

    coordinator.reconcile([{
      key: '/repo', cadence: 'foreground', eager: true, context: 'new', contextId: 'new'
    }]);
    requests[0]!.request.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    expect(requests[1]?.context).toBe('new');

    requests[1]!.request.resolve();
    await flush();
    expect(events).toEqual([{ result: 'new', cause: 'context' }]);
    coordinator.dispose();
  });

  it('preserves the newest filesystem cause and isolates throwing listeners', async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const coordinator = new GitRefreshCoordinator(async () => {
      call += 1;
      await (call === 1 ? first.promise : second.promise);
      return call;
    }, {
      intervals: { foreground: 100, background: 1_000 },
      jitterRatio: 0
    });
    const events: Array<{ occurredAt?: number; result: number }> = [];
    coordinator.subscribe(() => {
      throw new Error('listener failure');
    });
    coordinator.subscribe((event) => events.push({
      ...(event.cause.kind === 'filesystem' ? { occurredAt: event.cause.occurredAt } : {}),
      result: event.result
    }));
    coordinator.reconcile([{ key: '/repo', cadence: 'foreground', eager: true }]);
    await vi.advanceTimersByTimeAsync(0);
    coordinator.request('/repo', { kind: 'filesystem', occurredAt: 10 });
    coordinator.request('/repo', { kind: 'filesystem', occurredAt: 20 });
    first.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);

    second.resolve();
    await flush();
    expect(events).toEqual([{ occurredAt: 20, result: 2 }]);
    coordinator.dispose();
  });

  it('runs one filesystem observation accumulated while hidden on resume', async () => {
    const refresh = vi.fn(async (_key: string, _context: undefined, cause: { kind: string }) =>
      cause.kind
    );
    const coordinator = new GitRefreshCoordinator(refresh, {
      intervals: { foreground: 100, background: 1_000 },
      jitterRatio: 0
    });
    coordinator.reconcile([{ key: '/slow', cadence: 'background', eager: false }]);
    coordinator.setPollingPaused(true);
    coordinator.request('/slow', { kind: 'filesystem', occurredAt: 42 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).not.toHaveBeenCalled();

    coordinator.setPollingPaused(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]?.[2]).toEqual({ kind: 'filesystem', occurredAt: 42 });
    coordinator.dispose();
  });

  it('releases the resource group acquired before an in-flight context change', async () => {
    const requests = new Map<string, ReturnType<typeof deferred>>();
    const starts: string[] = [];
    const coordinator = new GitRefreshCoordinator<string>(async (key) => {
      starts.push(key);
      const request = deferred();
      requests.set(key, request);
      await request.promise;
    }, {
      intervals: { foreground: 100, background: 1_000 },
      maxConcurrency: 2,
      maxPerGroup: 1,
      jitterRatio: 0
    });
    coordinator.reconcile([
      { key: '/moving', cadence: 'foreground', eager: true, group: 'wsl:Ubuntu', context: 'a', contextId: 'a' },
      { key: '/waiting', cadence: 'foreground', eager: true, group: 'wsl:Ubuntu', context: 'a', contextId: 'a' }
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(['/moving']);

    coordinator.reconcile([
      { key: '/moving', cadence: 'foreground', eager: true, group: 'wsl:Debian', context: 'b', contextId: 'b' },
      { key: '/waiting', cadence: 'foreground', eager: true, group: 'wsl:Ubuntu', context: 'a', contextId: 'a' }
    ]);
    requests.get('/moving')!.resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toContain('/waiting');
    coordinator.dispose();
  });

  it('does not publish a late observation after its intent is removed', async () => {
    const request = deferred();
    const coordinator = new GitRefreshCoordinator(async () => {
      await request.promise;
      return 'late';
    }, {
      intervals: { foreground: 100, background: 1_000 },
      jitterRatio: 0
    });
    const listener = vi.fn();
    coordinator.subscribe(listener);
    coordinator.reconcile([{ key: '/removed', cadence: 'foreground', eager: true }]);
    await vi.advanceTimersByTimeAsync(0);
    coordinator.reconcile([]);
    request.resolve();
    await flush();

    expect(listener).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});
