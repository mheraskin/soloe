import { describe, expect, it, vi } from 'vitest';
import type { WslUsageSnapshot } from '@shared/types/system.js';
import { ResourceUsageObservation } from './ResourceUsageObservation.js';

describe('ResourceUsageObservation', () => {
  it('keeps summary observations free of WSL probes', async () => {
    const harness = createHarness();

    await expect(harness.observation.observe()).resolves.toMatchObject({
      cpuPercent: 4.2,
      wslActive: true,
      wsl: null
    });
    await harness.observation.observe({ detail: 'summary' });

    expect(harness.sampleWsl).not.toHaveBeenCalled();
  });

  it('shares demanded WSL detail with later summary observations', async () => {
    const harness = createHarness();

    const detailed = await harness.observation.observe({ detail: 'wsl' });
    const summary = await harness.observation.observe({ detail: 'summary' });

    expect(detailed.wsl).toEqual(harness.wslSnapshot);
    expect(summary.wsl).toEqual(harness.wslSnapshot);
    expect(harness.sampleWsl).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent app, distro, and WSL observations', async () => {
    let releaseWsl!: (value: WslUsageSnapshot) => void;
    const wslPending = new Promise<WslUsageSnapshot>((resolve) => {
      releaseWsl = resolve;
    });
    const harness = createHarness({ sampleWsl: () => wslPending });

    const first = harness.observation.observe({ detail: 'wsl' });
    const second = harness.observation.observe({ detail: 'wsl' });
    await vi.waitFor(() => expect(harness.sampleWsl).toHaveBeenCalledTimes(1));
    releaseWsl(harness.wslSnapshot);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(harness.collectAppUsage).toHaveBeenCalledTimes(1);
    expect(harness.getRunningWslDistros).toHaveBeenCalledTimes(1);
  });

  it('shares a failed WSL probe without a retry cascade', async () => {
    let rejectWsl!: (reason: Error) => void;
    const wslPending = new Promise<WslUsageSnapshot>((_resolve, reject) => {
      rejectWsl = reject;
    });
    const harness = createHarness({ sampleWsl: () => wslPending });

    const first = harness.observation.observe({ detail: 'wsl' });
    const second = harness.observation.observe({ detail: 'wsl' });
    await vi.waitFor(() => expect(harness.sampleWsl).toHaveBeenCalledTimes(1));
    rejectWsl(new Error('probe unavailable'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ wslActive: true, wsl: null }),
      expect.objectContaining({ wslActive: true, wsl: null })
    ]);
    expect(harness.sampleWsl).toHaveBeenCalledTimes(1);
  });

  it('expires WSL detail without allowing summaries to refresh it', async () => {
    const harness = createHarness();
    await harness.observation.observe({ detail: 'wsl' });

    harness.advance(1_001);
    const summary = await harness.observation.observe({ detail: 'summary' });
    expect(summary.wsl).toBeNull();
    expect(harness.sampleWsl).toHaveBeenCalledTimes(1);

    await harness.observation.observe({ detail: 'wsl' });
    expect(harness.sampleWsl).toHaveBeenCalledTimes(2);
  });

  it('invalidates detail and sampler continuity when WSL activity changes', async () => {
    const harness = createHarness();
    await harness.observation.observe({ detail: 'wsl' });
    harness.advance(1_001);
    harness.getRunningWslDistros.mockResolvedValue([]);

    await expect(harness.observation.observe({ detail: 'wsl' })).resolves.toMatchObject({
      wslActive: false,
      wsl: null
    });

    expect(harness.resetWsl).toHaveBeenCalledTimes(2);
    expect(harness.sampleWsl).toHaveBeenCalledTimes(1);
  });
});

function createHarness(overrides: {
  sampleWsl?: (distroCount: number) => Promise<WslUsageSnapshot | null>;
} = {}) {
  let now = 1_000;
  const wslSnapshot: WslUsageSnapshot = {
    cpuPercent: 12.5,
    memoryBytes: 512 * 1024 * 1024,
    memoryTotalBytes: 2 * 1024 * 1024 * 1024,
    distroCount: 1,
    sampledAt: '2026-07-14T00:00:00.000Z'
  };
  const collectAppUsage = vi.fn(async () => ({
    scope: 'client' as const,
    availability: 'available' as const,
    backendPlacement: null,
    cpuPercent: 4.2,
    memoryBytes: 128 * 1024 * 1024,
    processCount: 4,
    electronProcessCount: 3,
    childProcessCount: 1,
    components: [],
    sampledAt: '2026-07-14T00:00:00.000Z'
  }));
  const getRunningWslDistros = vi.fn(async () => ['Ubuntu', 'Ubuntu']);
  const sampleWsl = vi.fn(overrides.sampleWsl ?? (async () => wslSnapshot));
  const resetWsl = vi.fn();
  const observation = new ResourceUsageObservation({
    collectAppUsage,
    getRunningWslDistros,
    sampleWsl,
    resetWsl,
    now: () => now
  });
  return {
    observation,
    collectAppUsage,
    getRunningWslDistros,
    sampleWsl,
    resetWsl,
    wslSnapshot,
    advance: (ms: number) => { now += ms; }
  };
}
