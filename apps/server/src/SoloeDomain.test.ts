import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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

  it("owns the complete Git read, mutation, history, remote, and event contract", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-git-"));
    const worktree = path.join(directory, "worktree");
    const nonRepo = path.join(directory, "non-repo");
    const remote = path.join(directory, "remote.git");
    const createdWorktree = path.join(directory, "worktree-created");
    await mkdir(worktree);
    await mkdir(nonRepo);
    git(directory, ["init", "--bare", remote]);
    git(worktree, ["init", "-b", "main"]);
    git(worktree, ["config", "user.email", "soloe@example.test"]);
    git(worktree, ["config", "user.name", "Soloe Test"]);
    await writeFile(path.join(worktree, "app.txt"), "one\n");
    git(worktree, ["add", "app.txt"]);
    git(worktree, ["commit", "-m", "initial"]);
    git(worktree, ["branch", "feature/checkout"]);
    git(worktree, ["remote", "add", "origin", remote]);
    const initial = git(worktree, ["rev-parse", "HEAD"]);

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
      for (const [name, projectPath] of [
        ["Git project", worktree],
        ["Non-repository project", nonRepo],
      ]) {
        await domain.invoke({
          namespace: "projects",
          method: "create",
          args: [{ name, path: projectPath }],
        });
      }
      const scope = { runMode: hostPlatform() };

      await expect(
        domain.invoke({
          namespace: "git",
          method: "status",
          args: [{ cwd: worktree, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          repoPath: worktree,
          branch: "main",
          dirty: false,
        }),
      );
      for (const method of ["aheadBehind", "shortstat", "dirty"]) {
        await expect(
          domain.invoke({
            namespace: "git",
            method,
            args: [{ repoPath: worktree, force: true, ...scope }],
          }),
        ).resolves.toEqual(expect.objectContaining({ repoPath: worktree, isRepo: true }));
      }
      await expect(
        domain.invoke({
          namespace: "git",
          method: "worktrees",
          args: [{ repoPath: worktree, ...scope }],
        }),
      ).resolves.toEqual([
        expect.objectContaining({ path: worktree, branch: "main", isMain: true }),
      ]);
      await expect(
        domain.invoke({
          namespace: "git",
          method: "branches",
          args: [{ repoPath: worktree, ...scope }],
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "main", current: true }),
        ]),
      );
      for (const method of ["recentCommits", "refHistory"]) {
        await expect(
          domain.invoke({
            namespace: "git",
            method,
            args: [{ repoPath: worktree, limit: 20, ...scope }],
          }),
        ).resolves.toEqual([
          expect.objectContaining({ hash: initial, subject: "initial" }),
        ]);
      }
      await expect(
        domain.invoke({
          namespace: "git",
          method: "resolveRefs",
          args: [{ cwd: worktree, refs: ["HEAD", "missing"], ...scope }],
        }),
      ).resolves.toEqual({ resolved: [initial, null] });

      await writeFile(path.join(worktree, "app.txt"), "one\ntwo\n");
      await writeFile(path.join(worktree, "new.txt"), "new\n");
      await expect(
        domain.invoke({
          namespace: "git",
          method: "checkout",
          args: [{ repoPath: worktree, ref: "feature/checkout", ...scope }],
        }),
      ).rejects.toMatchObject({ code: "dirty_checkout" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "workingTreeSnapshot",
          args: [{ cwd: worktree, force: true, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: expect.objectContaining({ dirty: true, unstaged: 1, untracked: 1 }),
          workingChanges: expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({ path: "app.txt", kind: "modified" }),
              expect.objectContaining({ path: "new.txt", kind: "untracked" }),
            ]),
          }),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "workingChanges",
          args: [{ cwd: worktree, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          changes: expect.arrayContaining([
            expect.objectContaining({ path: "app.txt" }),
          ]),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fileDiff",
          args: [{ cwd: worktree, path: "app.txt", ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          path: "app.txt",
          empty: false,
          hunks: expect.arrayContaining([expect.any(Object)]),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "reviewDiffs",
          args: [{ cwd: worktree, files: [{ path: "app.txt" }], ...scope }],
        }),
      ).resolves.toEqual([
        expect.objectContaining({ path: "app.txt", empty: false }),
      ]);

      await domain.invoke({
        namespace: "git",
        method: "stageFiles",
        args: [{ cwd: worktree, paths: ["app.txt", "new.txt"], ...scope }],
      });
      await domain.invoke({
        namespace: "git",
        method: "unstageFiles",
        args: [{ cwd: worktree, paths: ["app.txt", "new.txt"], ...scope }],
      });
      await domain.invoke({
        namespace: "git",
        method: "discardFiles",
        args: [
          {
            cwd: worktree,
            files: [
              { path: "app.txt", kind: "modified" },
              { path: "new.txt", kind: "untracked" },
            ],
            ...scope,
          },
        ],
      });
      expect(await readFile(path.join(worktree, "app.txt"), "utf8")).toBe("one\n");

      await writeFile(path.join(worktree, "app.txt"), "one\ntwo\n");
      const committed = (await domain.invoke({
        namespace: "git",
        method: "commit",
        args: [
          {
            cwd: worktree,
            message: "server git commit",
            stageAll: true,
            ...scope,
          },
        ],
      })) as { hash: string };
      expect(committed.hash).toMatch(/^[0-9a-f]{40}$/u);

      await expect(
        domain.invoke({
          namespace: "git",
          method: "commitsBetween",
          args: [{ cwd: worktree, base: initial, head: committed.hash, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          base: initial,
          head: committed.hash,
          commits: [expect.objectContaining({ hash: committed.hash })],
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "rangeChanges",
          args: [{ cwd: worktree, base: initial, head: committed.hash, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          changes: [expect.objectContaining({ path: "app.txt", insertions: 1 })],
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fileBlame",
          args: [{ cwd: worktree, path: "app.txt", head: committed.hash, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          head: committed.hash,
          lines: expect.arrayContaining([
            expect.objectContaining({ lineNo: 2, sha: committed.hash }),
          ]),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fileLines",
          args: [
            {
              cwd: worktree,
              path: "app.txt",
              revision: { kind: "commit", sha: committed.hash },
              startLine: 1,
              endLine: 2,
              ...scope,
            },
          ],
        }),
      ).resolves.toEqual({ lines: ["one", "two"], totalLines: 2 });

      await domain.invoke({
        namespace: "git",
        method: "push",
        args: [
          {
            cwd: worktree,
            remote: "origin",
            branch: "main",
            setUpstream: true,
            ...scope,
          },
        ],
      });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fetch",
          args: [{ cwd: worktree, remote: "origin", ...scope }],
        }),
      ).resolves.toEqual(expect.objectContaining({ stdout: expect.any(String) }));
      await expect(
        domain.invoke({
          namespace: "git",
          method: "pull",
          args: [{ cwd: worktree, remote: "origin", branch: "main", ...scope }],
        }),
      ).resolves.toEqual(expect.objectContaining({ stdout: expect.any(String) }));
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fetch",
          args: [{ cwd: worktree, remote: "missing", ...scope }],
        }),
      ).rejects.toMatchObject({ code: "remote_failure" });

      await expect(
        domain.invoke({
          namespace: "git",
          method: "createWorktree",
          args: [
            {
              repoPath: worktree,
              path: createdWorktree,
              branch: "feature/server-worktree",
              baseRef: "main",
              ...scope,
            },
          ],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          path: createdWorktree,
          branch: "feature/server-worktree",
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "checkout",
          args: [{ repoPath: worktree, ref: "feature/checkout", ...scope }],
        }),
      ).resolves.toEqual(expect.objectContaining({ branch: "feature/checkout" }));

      await expect(
        domain.invoke({
          namespace: "git",
          method: "rangeChanges",
          args: [{ cwd: worktree, base: "missing", head: "HEAD", ...scope }],
        }),
      ).rejects.toMatchObject({ code: "invalid_revision" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "stageFiles",
          args: [{ cwd: worktree, paths: ["../outside"], ...scope }],
        }),
      ).rejects.toMatchObject({ code: "invalid_git_path" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fetch",
          args: [{ cwd: worktree, remote: "--upload-pack=evil", ...scope }],
        }),
      ).rejects.toMatchObject({ code: "invalid_git_request" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "stageFiles",
          args: [{ cwd: nonRepo, paths: ["file.txt"], ...scope }],
        }),
      ).rejects.toMatchObject({ code: "repository_not_found" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "status",
          args: [{ cwd: directory, ...scope }],
        }),
      ).rejects.toMatchObject({ code: "worktree_not_authorized" });

      await domain.invoke({
        namespace: "git",
        method: "setObservationDemand",
        args: [
          {
            cwd: worktree,
            active: true,
            runMode: "wsl",
            wslDistro: "Ubuntu-Test",
          },
        ],
        clientId: "git-browser",
      });
      await domain.invoke({
        namespace: "git",
        method: "stageFiles",
        args: [
          {
            cwd: worktree,
            paths: ["app.txt"],
            runMode: "wsl",
            wslDistro: "Ubuntu-Test",
          },
        ],
      });
      await vi.waitFor(
        () => {
          expect(published).toContainEqual({
            event: "git.change",
            payload: {
              repoPath: worktree,
              runMode: "wsl",
              wslDistro: "Ubuntu-Test",
            },
          });
        },
        { timeout: 1_000 },
      );
      domain.releaseClient("git-browser");
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}
