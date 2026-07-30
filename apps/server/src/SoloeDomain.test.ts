import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostPlatform } from "../../../shared/platform.js";
import { SoloeDomain } from "./SoloeDomain.js";

describe("SoloeDomain", () => {
  it("persists a Session and starts it through the independent runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-"));
    const runtime = {
      start: vi.fn(async (input) => ({
        terminalId: "domain-terminal",
        sessionId: input.sessionId,
        pid: 7001,
        status: "running" as const,
        startedAt: "2026-07-30T10:00:00.000Z",
        spec: input.spec,
        cols: input.cols,
        rows: input.rows,
      })),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };

    try {
      const domain = new SoloeDomain({ dataDirectory: directory, runtime });
      await domain.init();
      const project = (await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Browser project", path: directory }],
      })) as { id: string };
      expect(
        await domain.invoke({ namespace: "projects", method: "list", args: [] }),
      ).toEqual([expect.objectContaining({ id: project.id, name: "Browser project" })]);

      const session = (await domain.invoke({
        namespace: "sessions",
        method: "create",
        args: [
          {
            name: "Browser terminal",
            cwd: directory,
            runMode: hostPlatform(),
            launch: { type: "terminal", shell: "auto" },
          },
        ],
      })) as { id: string };

      const started = await domain.invoke({
        namespace: "terminal",
        method: "start",
        args: [{ sessionId: session.id, cols: 100, rows: 30 }],
      });

      expect(started).toEqual(
        expect.objectContaining({
          terminalId: "domain-terminal",
          sessionId: session.id,
          pid: 7001,
        }),
      );
      expect(runtime.start).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          spec: expect.objectContaining({
            file: expect.any(String),
            cwd: directory,
          }),
          cols: 100,
          rows: 30,
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
