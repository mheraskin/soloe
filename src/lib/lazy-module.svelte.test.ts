import { describe, expect, it, vi } from 'vitest';
import { LazyModule } from './lazy-module.svelte';

describe('LazyModule', () => {
  it('coalesces concurrent loads and reuses the loaded value', async () => {
    let resolve!: (value: { name: string }) => void;
    const loader = vi.fn(
      () => new Promise<{ name: string }>((done) => {
        resolve = done;
      })
    );
    const module = new LazyModule(loader);

    const first = module.load();
    const second = module.load();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(module.loading).toBe(true);

    resolve({ name: 'browser' });
    await expect(first).resolves.toEqual({ name: 'browser' });
    await expect(second).resolves.toEqual({ name: 'browser' });
    await expect(module.load()).resolves.toEqual({ name: 'browser' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(module.loading).toBe(false);
  });

  it('captures failures and retries on the next load', async () => {
    const loader = vi
      .fn<() => Promise<{ name: string }>>()
      .mockRejectedValueOnce('offline')
      .mockResolvedValueOnce({ name: 'diff' });
    const module = new LazyModule(loader);

    await expect(module.load()).resolves.toBeNull();
    expect(module.error?.message).toBe('offline');

    await expect(module.load()).resolves.toEqual({ name: 'diff' });
    expect(module.error).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
