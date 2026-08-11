import { describe, expect, it } from 'vitest';
import { GitProcessExecutor } from './GitProcessExecutor.js';

describe('GitProcessExecutor', () => {
  it('admits no more than the configured number of physical processes', async () => {
    const executor = new GitProcessExecutor(2);
    const first = await executor.acquire();
    const second = await executor.acquire();
    let thirdAdmitted = false;
    const thirdRequest = executor.acquire().then((release) => {
      thirdAdmitted = true;
      return release;
    });

    await Promise.resolve();
    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');
    expect(thirdAdmitted).toBe(false);

    first?.();
    const third = await thirdRequest;
    expect(thirdAdmitted).toBe(true);
    third?.();
    second?.();
  });

  it('removes an aborted waiter without consuming a later permit', async () => {
    const executor = new GitProcessExecutor(1);
    const first = await executor.acquire();
    const controller = new AbortController();
    const abortedRequest = executor.acquire(controller.signal);
    const laterRequest = executor.acquire();

    controller.abort();
    await expect(abortedRequest).resolves.toBeNull();
    first?.();
    const later = await laterRequest;
    expect(later).toBeTypeOf('function');
    later?.();
  });

  it('rejects invalid limits', () => {
    expect(() => new GitProcessExecutor(0)).toThrow('positive integer');
  });
});
