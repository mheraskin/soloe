import { describe, expect, it, vi } from 'vitest';
import { GroupedTaskPool } from './grouped-task-pool';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

describe('GroupedTaskPool', () => {
  it('bounds global work and serializes tasks sharing a resource group', async () => {
    const pool = new GroupedTaskPool(2, 1);
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const starts: string[] = [];
    const run = (key: string, group?: string) => pool.run(async () => {
      starts.push(key);
      const gate = deferred();
      gates.set(key, gate);
      await gate.promise;
      return key;
    }, group ? { group } : {});

    const results = [
      run('ubuntu-a', 'wsl:Ubuntu'),
      run('ubuntu-b', 'wsl:Ubuntu'),
      run('native'),
      run('debian', 'wsl:Debian')
    ];
    await flush();
    expect(starts).toEqual(['ubuntu-a', 'native']);

    gates.get('ubuntu-a')!.resolve();
    await flush();
    expect(starts).toContain('ubuntu-b');
    gates.get('native')!.resolve();
    gates.get('ubuntu-b')!.resolve();
    await flush();
    gates.get('debian')!.resolve();
    await expect(Promise.all(results)).resolves.toEqual([
      'ubuntu-a', 'ubuntu-b', 'native', 'debian'
    ]);
  });

  it('prefers urgent queued work when capacity becomes available', async () => {
    const pool = new GroupedTaskPool(1);
    const first = deferred();
    const starts: string[] = [];
    const initial = pool.run(async () => {
      starts.push('initial');
      await first.promise;
    });
    await flush();
    const low = pool.run(() => { starts.push('low'); }, { priority: 0 });
    const high = pool.run(() => { starts.push('high'); }, { priority: 10 });

    first.resolve();
    await initial;
    await Promise.all([low, high]);
    expect(starts).toEqual(['initial', 'high', 'low']);
  });

  it('releases capacity after rejection', async () => {
    const pool = new GroupedTaskPool(1);
    const failure = pool.run(() => Promise.reject(new Error('boom')));
    const next = vi.fn(() => 'ok');
    const success = pool.run(next);
    await expect(failure).rejects.toThrow('boom');
    await expect(success).resolves.toBe('ok');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
