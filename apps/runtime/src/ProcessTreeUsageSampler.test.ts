import { describe, expect, it, vi } from "vitest";
import {
  ProcessTreeUsageSampler,
  parseProcessUsageRows,
} from "./ProcessTreeUsageSampler.js";

describe("ProcessTreeUsageSampler", () => {
  it("aggregates the runtime and all descendant PTY processes", async () => {
    const sampler = new ProcessTreeUsageSampler({
      rootPid: 10,
      platform: "linux",
      now: () => new Date("2026-07-31T12:00:00.000Z"),
      listRows: async () => [
        { pid: 10, parentPid: 1, memoryKb: 100, cpuPercent: 1.25 },
        { pid: 11, parentPid: 10, memoryKb: 50, cpuPercent: 2 },
        { pid: 12, parentPid: 11, memoryKb: 25, cpuPercent: 3.25 },
        { pid: 99, parentPid: 1, memoryKb: 999, cpuPercent: 99 },
      ],
    });

    await expect(sampler.sample()).resolves.toEqual({
      availability: "available",
      cpuPercent: 6.5,
      memoryBytes: 175 * 1024,
      processCount: 3,
      components: [
        {
          kind: "runtime",
          availability: "available",
          cpuPercent: 1.3,
          memoryBytes: 100 * 1024,
          processCount: 1,
        },
        {
          kind: "agent-pty",
          availability: "available",
          cpuPercent: 5.3,
          memoryBytes: 75 * 1024,
          processCount: 2,
        },
      ],
      sampledAt: "2026-07-31T12:00:00.000Z",
    });
  });

  it("coalesces overlapping physical samples", async () => {
    let release!: (rows: []) => void;
    const pending = new Promise<[]>((resolve) => {
      release = resolve;
    });
    const listRows = vi.fn(() => pending);
    const sampler = new ProcessTreeUsageSampler({
      rootPid: 10,
      platform: "linux",
      listRows,
    });

    const first = sampler.sample();
    const second = sampler.sample();
    expect(first).toBe(second);
    release([]);
    await Promise.all([first, second]);
    expect(listRows).toHaveBeenCalledTimes(1);
  });

  it("returns an explicit unavailable state on unsupported platforms", async () => {
    const listRows = vi.fn(async () => []);
    const sampler = new ProcessTreeUsageSampler({
      rootPid: 10,
      platform: "win32",
      listRows,
    });

    await expect(sampler.sample()).resolves.toMatchObject({
      availability: "unavailable",
      cpuPercent: null,
      memoryBytes: null,
      processCount: null,
      message: "process tree sampling is not available on this platform",
    });
    expect(listRows).not.toHaveBeenCalled();
  });

  it("parses only valid process rows", () => {
    expect(
      parseProcessUsageRows(
        " 10 1 2048 1.5\n11 10 512 0.0\ninvalid\n12 10 -1 4\n",
      ),
    ).toEqual([
      { pid: 10, parentPid: 1, memoryKb: 2048, cpuPercent: 1.5 },
      { pid: 11, parentPid: 10, memoryKb: 512, cpuPercent: 0 },
    ]);
  });
});
