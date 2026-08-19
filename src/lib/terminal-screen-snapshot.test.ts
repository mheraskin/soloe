import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadTerminalScreenSnapshot,
  TERMINAL_SCREEN_SNAPSHOT_TIMEOUT_MS
} from './terminal-screen-snapshot';

describe('loadTerminalScreenSnapshot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a snapshot that arrives before the deadline', async () => {
    const snapshot = { data: 'restored' };

    await expect(loadTerminalScreenSnapshot(async () => snapshot)).resolves.toBe(snapshot);
  });

  it('falls back when a mobile request remains pending', async () => {
    vi.useFakeTimers();
    const pending = loadTerminalScreenSnapshot(
      () => new Promise<never>(() => undefined)
    );

    await vi.advanceTimersByTimeAsync(TERMINAL_SCREEN_SNAPSHOT_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
  });
});
