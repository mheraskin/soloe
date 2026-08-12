import { describe, expect, it, vi } from 'vitest';
import { NativeWriteCompletion } from './native-write-completion';

describe('NativeWriteCompletion', () => {
  it('keeps presentation writes pending until the native parser acknowledges them', async () => {
    const completions = new NativeWriteCompletion();
    const settled = vi.fn();

    const pending = completions.wait(7).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    completions.complete(7);
    await pending;
    expect(settled).toHaveBeenCalledOnce();
  });

  it('handles an acknowledgement that races ahead of the invoke response', async () => {
    const completions = new NativeWriteCompletion();
    completions.complete(11);

    await expect(completions.wait(11)).resolves.toBeUndefined();
  });

  it('releases pending writes when the disposable presentation goes away', async () => {
    const completions = new NativeWriteCompletion();
    const pending = completions.wait(19);

    completions.dispose();

    await expect(pending).resolves.toBeUndefined();
  });
});
