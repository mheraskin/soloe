import { describe, expect, it, vi } from "vitest";
import type { RuntimeUsageSnapshot } from "@soloe/protocol";
import { BackendUsageObservation } from "./BackendUsageObservation.js";

describe("BackendUsageObservation", () => {
  it("combines server, runtime, and PTY metrics with explicit backend scope", async () => {
    const observation = new BackendUsageObservation({
      collectServerUsage: async () => usage(1, 100, 1),
      collectRuntimeUsage: async () => usage(2, 200, 3),
      backendPlacement: "native",
    });

    await expect(observation.observe()).resolves.toMatchObject({
      scope: "backend",
      availability: "available",
      backendPlacement: "native",
      cpuPercent: 3,
      memoryBytes: 300,
      processCount: 4,
      electronProcessCount: null,
      wslActive: false,
      components: [
        { kind: "application-server", availability: "available" },
        { kind: "agent-worker", availability: "available" },
        { kind: "runtime", availability: "available" },
        { kind: "agent-pty", availability: "available" },
      ],
    });
  });

  it("reports degraded WSL data without inventing supervisor values", async () => {
    const observation = new BackendUsageObservation({
      collectServerUsage: async () => usage(1, 100, 1),
      collectRuntimeUsage: async () => {
        throw new Error("runtime disconnected");
      },
      backendPlacement: "wsl",
    });

    const snapshot = await observation.observe();
    expect(snapshot).toMatchObject({
      scope: "backend",
      availability: "degraded",
      cpuPercent: 1,
      memoryBytes: 100,
      processCount: 1,
      wslActive: true,
      message: "some backend process metrics are unavailable",
    });
    expect(snapshot.components).toContainEqual(
      expect.objectContaining({
        kind: "runtime",
        availability: "unavailable",
        cpuPercent: null,
      }),
    );
    expect(snapshot.components).toContainEqual(
      expect.objectContaining({
        kind: "wsl-supervisor",
        availability: "unavailable",
        memoryBytes: null,
      }),
    );
  });

  it("coalesces and briefly caches samples", async () => {
    let now = 1_000;
    const collectServerUsage = vi.fn(async () => usage(1, 100, 1));
    const collectRuntimeUsage = vi.fn(async () => usage(2, 200, 1));
    const observation = new BackendUsageObservation({
      collectServerUsage,
      collectRuntimeUsage,
      now: () => now,
      cacheMs: 1_000,
    });

    await Promise.all([observation.observe(), observation.observe()]);
    await observation.observe();
    expect(collectServerUsage).toHaveBeenCalledTimes(1);
    expect(collectRuntimeUsage).toHaveBeenCalledTimes(1);

    now += 1_001;
    await observation.observe();
    expect(collectServerUsage).toHaveBeenCalledTimes(2);
    expect(collectRuntimeUsage).toHaveBeenCalledTimes(2);
  });
});

function usage(
  cpuPercent: number,
  memoryBytes: number,
  processCount: number,
): RuntimeUsageSnapshot {
  return {
    availability: "available",
    cpuPercent,
    memoryBytes,
    processCount,
    components: [
      {
        kind: "runtime",
        availability: "available",
        cpuPercent,
        memoryBytes,
        processCount: 1,
      },
      {
        kind: "agent-pty",
        availability: "available",
        cpuPercent: 0,
        memoryBytes: 0,
        processCount: Math.max(0, processCount - 1),
      },
    ],
    sampledAt: "2026-07-31T12:00:00.000Z",
  };
}
