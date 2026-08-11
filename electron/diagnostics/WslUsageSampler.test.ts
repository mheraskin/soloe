import { describe, expect, it, vi } from 'vitest';
import { parseWslKernelSnapshot, WslUsageSampler } from './WslUsageSampler.js';

describe('WslUsageSampler', () => {
  it('parses VM-wide CPU counters and memory pressure from proc files', () => {
    expect(parseWslKernelSnapshot(procSnapshot({
      cpu: '100 10 20 1000 5 2 3 0 0 0',
      totalKb: 1_000_000,
      availableKb: 400_000
    }))).toEqual({
      totalTicks: 1140,
      busyTicks: 135,
      memoryBytes: 600_000 * 1024,
      memoryTotalBytes: 1_000_000 * 1024
    });
  });

  it('calculates CPU from deltas and reports the number of active distros', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(procSnapshot({
        cpu: '100 0 20 1000 0 0 0 0 0 0',
        totalKb: 2_000_000,
        availableKb: 1_500_000
      }))
      .mockResolvedValueOnce(procSnapshot({
        // Delta: 70 busy ticks, 30 idle ticks => 70% CPU.
        cpu: '150 0 40 1030 0 0 0 0 0 0',
        totalKb: 2_000_000,
        availableKb: 1_250_000
      }));
    const sampler = new WslUsageSampler({
      probe,
      now: vi.fn()
        .mockReturnValueOnce(new Date('2026-07-14T00:00:00Z'))
        .mockReturnValueOnce(new Date('2026-07-14T00:00:05Z'))
    });

    await expect(sampler.sample(2)).resolves.toMatchObject({
      cpuPercent: null,
      memoryBytes: 500_000 * 1024,
      distroCount: 2
    });
    await expect(sampler.sample(2)).resolves.toEqual({
      cpuPercent: 70,
      memoryBytes: 750_000 * 1024,
      memoryTotalBytes: 2_000_000 * 1024,
      distroCount: 2,
      sampledAt: '2026-07-14T00:00:05.000Z'
    });
  });

  it('resets the CPU baseline after an unavailable sample', async () => {
    const valid = procSnapshot({
      cpu: '100 0 20 1000 0 0 0 0 0 0',
      totalKb: 1000,
      availableKb: 400
    });
    const probe = vi.fn()
      .mockResolvedValueOnce(valid)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(valid);
    const sampler = new WslUsageSampler({ probe });

    expect((await sampler.sample(1))?.cpuPercent).toBeNull();
    await expect(sampler.sample(1)).resolves.toBeNull();
    expect((await sampler.sample(1))?.cpuPercent).toBeNull();
  });
});

function procSnapshot(input: {
  cpu: string;
  totalKb: number;
  availableKb: number;
}): string {
  return [
    `cpu  ${input.cpu}`,
    'cpu0 1 2 3 4 5 6 7 8 9 10',
    `MemTotal:       ${input.totalKb} kB`,
    `MemAvailable:   ${input.availableKb} kB`
  ].join('\n');
}
