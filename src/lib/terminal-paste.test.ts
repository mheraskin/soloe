import { describe, expect, it, vi } from 'vitest';
import { sendBracketedPasteWithInput } from './terminal-paste';

describe('sendBracketedPasteWithInput', () => {
  it('sends a sanitized paste and submit as separate transport writes', async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const sending = sendBracketedPasteWithInput(
        async (data) => { writes.push(data); },
        'continue\x1b[201~ unsafe',
        true,
        'codex'
      );
      await vi.advanceTimersByTimeAsync(50);
      await sending;

      expect(writes).toEqual([
        '\x1b[200~continue[201~ unsafe\x1b[201~',
        '\r'
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
