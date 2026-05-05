import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentObserverManager } from './AgentObserverManager.js';
import { AgentObserverStore } from './AgentObserverStore.js';
import { detectUsageLimit } from './UsageLimitDetector.js';

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
});
