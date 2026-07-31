import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DiagnosticsService,
  redactSensitive,
} from "./DiagnosticsService.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("DiagnosticsService log access", () => {
  it("returns bounded service and crash tails without host paths or secrets", async () => {
    const root = await fixtureRoot();
    const crashDir = path.join(root, "crashes");
    await mkdir(crashDir);
    await writeFile(
      path.join(root, "server.log"),
      `before\nAuthorization: Bearer server-token\n${"x".repeat(100)}`,
      "utf8",
    );
    await writeFile(
      path.join(crashDir, "crash-1.log"),
      'error token="crash-token" password=hunter2\n',
      "utf8",
    );
    const service = createService(root);

    const logs = await service.crashLogs({ tailBytes: 64 });

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileName: "server.log",
          service: "server",
          severity: "info",
          sizeBytes: expect.any(Number),
          truncated: true,
        }),
        expect.objectContaining({
          fileName: "crash-1.log",
          service: "crash",
          severity: "error",
          tail: expect.not.stringContaining("crash-token"),
        }),
      ]),
    );
    expect(JSON.stringify(logs)).not.toContain(root);
    expect(JSON.stringify(logs)).not.toContain("hunter2");
  });

  it("rejects symlink logs and ignores unknown files", async () => {
    const root = await fixtureRoot();
    const crashDir = path.join(root, "crashes");
    await mkdir(crashDir);
    const outside = path.join(root, "outside.log");
    await writeFile(outside, "token=outside-secret\n", "utf8");
    await symlink(outside, path.join(crashDir, "linked.log"));
    await writeFile(path.join(crashDir, "../not-a-log.txt"), "ignored", "utf8");

    await expect(createService(root).crashLogs()).resolves.toEqual([]);
  });

  it("validates the tail bound", async () => {
    const root = await fixtureRoot();
    await expect(
      createService(root).crashLogs({ tailBytes: 65_537 }),
    ).rejects.toThrow("tailBytes must be an integer");
  });

  it("redacts common credential forms", () => {
    const redacted = redactSensitive([
      "Bearer abc.def",
      'token: "secret-value"',
      "GITHUB_TOKEN=ghp_example",
      "AWS_ACCESS_KEY_ID=access-example",
      "https://localhost/?api_key=query-secret",
      "postgres://alice:database-secret@localhost/app",
    ].join("\n"));

    expect(redacted).not.toMatch(
      /abc\.def|secret-value|ghp_example|access-example|query-secret|database-secret/u,
    );
    expect(redacted.match(/\[REDACTED\]/gu)).toHaveLength(6);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "soloe-diagnostics-"));
  scratch.push(root);
  return root;
}

function createService(root: string): DiagnosticsService {
  return new DiagnosticsService({
    settings: { get: async () => ({ binaries: {} }) },
    projects: { list: async () => [] },
    git: { getDirty: async () => ({ isRepo: false }) },
    crashDir: path.join(root, "crashes"),
    logDirectory: root,
  });
}
