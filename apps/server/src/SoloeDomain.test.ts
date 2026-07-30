import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostPlatform } from "../../../shared/platform.js";
import { SoloeDomain } from "./SoloeDomain.js";

describe("SoloeDomain", () => {
  it("implements every RPC required during shared UI startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-startup-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };

    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    try {
      await domain.init();

      await expect(
        Promise.all([
          domain.invoke({ namespace: "system", method: "platform", args: [] }),
          domain.invoke({ namespace: "settings", method: "get", args: [] }),
          domain.invoke({ namespace: "projects", method: "list", args: [] }),
          domain.invoke({ namespace: "sessions", method: "list", args: [] }),
          domain.invoke({ namespace: "sessions", method: "listArchived", args: [] }),
          domain.invoke({ namespace: "terminal", method: "listRunning", args: [] }),
          domain.invoke({ namespace: "observer", method: "list", args: [] }),
          domain.invoke({ namespace: "agentIntegration", method: "status", args: [] }),
        ]),
      ).resolves.toEqual([
        expect.any(Object),
        expect.any(Object),
        [],
        [],
        [],
        [],
        [],
        { hosts: [] },
      ]);
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

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

    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    try {
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
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("owns observer snapshots, events, and worker operations in the server domain", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-observer-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    const published: Array<{ event: string; payload: unknown }> = [];
    domain.on("event", (event, payload) => published.push({ event, payload }));

    try {
      await domain.init();
      const session = (await domain.invoke({
        namespace: "sessions",
        method: "create",
        args: [
          {
            name: "Observed terminal",
            cwd: directory,
            runMode: hostPlatform(),
            launch: { type: "terminal", shell: "auto" },
          },
        ],
      })) as { id: string };

      expect(
        await domain.invoke({ namespace: "observer", method: "list", args: [] }),
      ).toEqual([
        expect.objectContaining({
          id: session.id,
          subjectKind: "session",
          runtimeMode: "tui",
        }),
      ]);

      const worker = (await domain.invoke({
        namespace: "observer",
        method: "createWorkerSession",
        args: [
          {
            originSessionId: session.id,
            provider: "codex",
            promptSummary: "Review the change",
          },
        ],
      })) as { workerId: string };
      expect(
        await domain.invoke({
          namespace: "observer",
          method: "getWorkerStatus",
          args: [worker.workerId],
        }),
      ).toEqual({
        snapshot: expect.objectContaining({
          workerId: worker.workerId,
          originSessionId: session.id,
        }),
      });
      expect(
        await domain.invoke({
          namespace: "observer",
          method: "listEvents",
          args: [{ subjectId: worker.workerId }],
        }),
      ).toEqual([
        expect.objectContaining({
          subjectId: worker.workerId,
          summary: "worker registered",
        }),
      ]);
      expect(published).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "observer.snapshot" }),
          expect.objectContaining({ event: "observer.event" }),
        ]),
      );
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("owns file tree, search, read, write, and terminal paste operations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-files-"));
    const worktree = path.join(directory, "worktree");
    const outside = path.join(directory, "outside");
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(worktree, "src", "app.ts"), "export const app = true;\n");
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    await symlink(outside, path.join(worktree, "escape"));

    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => [
        {
          terminalId: "files-terminal",
          sessionId: "files-session",
          pid: 7002,
          status: "running" as const,
          startedAt: "2026-07-31T00:00:00.000Z",
          spec: { file: "shell", args: [], cwd: worktree, env: {} },
          cols: 100,
          rows: 30,
        },
      ]),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });

    try {
      await domain.init();
      await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Files project", path: worktree }],
      });

      const scope = { cwd: worktree, runMode: hostPlatform() };
      await expect(
        domain.invoke({ namespace: "files", method: "listTree", args: [scope] }),
      ).resolves.toEqual(
        expect.objectContaining({
          cwd: worktree,
          paths: expect.arrayContaining(["src/app.ts"]),
          truncated: false,
        }),
      );
      await expect(
        domain.invoke({
          namespace: "files",
          method: "search",
          args: [{ ...scope, query: "app", limit: 20 }],
        }),
      ).resolves.toEqual([
        expect.objectContaining({ rootPath: worktree, path: "src/app.ts" }),
      ]);
      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{ ...scope, relativePath: "src/app.ts" }],
        }),
      ).resolves.toEqual({
        relativePath: "src/app.ts",
        content: "export const app = true;\n",
        binary: false,
        truncated: false,
        oversized: false,
        unavailable: false,
        size: 25,
      });

      await domain.invoke({
        namespace: "files",
        method: "writeFile",
        args: [{ ...scope, relativePath: "src/app.ts", content: "saved\n" }],
      });
      expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe(
        "saved\n",
      );

      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{ ...scope, relativePath: "../outside/secret.txt" }],
        }),
      ).rejects.toMatchObject({ code: "path_traversal" });
      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{ ...scope, relativePath: "escape/secret.txt" }],
        }),
      ).rejects.toMatchObject({ code: "path_symlink_escape" });
      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{ ...scope, cwd: outside, relativePath: "secret.txt" }],
        }),
      ).rejects.toMatchObject({ code: "worktree_not_authorized" });

      await expect(
        domain.invoke({
          namespace: "files",
          method: "pasteIntoTerminal",
          args: [{ terminalId: "files-terminal", path: "src/app.ts" }],
        }),
      ).resolves.toBe(true);
      expect(runtime.write).toHaveBeenCalledWith("files-terminal", "src/app.ts");
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
