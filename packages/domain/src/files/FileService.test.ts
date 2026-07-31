import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileService } from "./FileService.js";

let directory: string;
let root: string;
let outside: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "soloe-file-service-"));
  root = path.join(directory, "worktree");
  outside = path.join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("FileService", () => {
  it("returns explicit text, binary, oversized, and unavailable metadata", async () => {
    await writeFile(path.join(root, "text.txt"), "hello\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, "large.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    const service = createService();
    const scope = { cwd: root, runMode: "linux" as const };

    await expect(
      service.readFile({ ...scope, relativePath: "text.txt" }),
    ).resolves.toEqual({
      relativePath: "text.txt",
      content: "hello\n",
      binary: false,
      truncated: false,
      oversized: false,
      unavailable: false,
      size: 6,
    });
    await expect(
      service.readFile({ ...scope, relativePath: "binary.bin" }),
    ).resolves.toEqual({
      relativePath: "binary.bin",
      content: "",
      binary: true,
      truncated: false,
      oversized: false,
      unavailable: false,
      size: 3,
    });
    await expect(
      service.readFile({ ...scope, relativePath: "large.txt" }),
    ).resolves.toEqual(
      expect.objectContaining({
        content: "",
        binary: false,
        truncated: true,
        oversized: true,
        unavailable: false,
        size: 5 * 1024 * 1024 + 1,
        maxBytes: 5 * 1024 * 1024,
      }),
    );
    await expect(
      service.readFile({ ...scope, relativePath: "missing.txt" }),
    ).resolves.toEqual(
      expect.objectContaining({
        unavailable: true,
        unavailableReason: "not_found",
      }),
    );
    service.dispose();
  });

  it("rejects traversal, absolute paths, symlink escape, and unauthorized roots", async () => {
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(outside, path.join(root, "escape"));
    const service = createService();
    const scope = { cwd: root, runMode: "linux" as const };

    await expect(
      service.readFile({ ...scope, relativePath: "../outside/secret.txt" }),
    ).rejects.toMatchObject({ code: "path_traversal" });
    await expect(
      service.readFile({ ...scope, relativePath: path.join(outside, "secret.txt") }),
    ).rejects.toMatchObject({ code: "absolute_path_forbidden" });
    await expect(
      service.readFile({ ...scope, relativePath: "escape/secret.txt" }),
    ).rejects.toMatchObject({ code: "path_symlink_escape" });
    await expect(
      service.readFile({
        cwd: outside,
        runMode: "linux",
        relativePath: "secret.txt",
      }),
    ).rejects.toMatchObject({ code: "worktree_not_authorized" });
    service.dispose();
  });

  it("writes only to a running runtime-owned terminal", async () => {
    const write = vi.fn(async () => undefined);
    const service = createService({
      runtime: {
        listRunning: async () => [
          { terminalId: "terminal-1", sessionId: "session-1" },
        ],
        write,
      },
    });

    await expect(
      service.pasteIntoTerminal({
        terminalId: "terminal-1",
        path: "src/app.ts",
      }),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith("terminal-1", "src/app.ts");
    await expect(
      service.pasteIntoTerminal({
        terminalId: "missing",
        path: "src/app.ts",
      }),
    ).rejects.toMatchObject({ code: "terminal_not_found" });
    service.dispose();
  });

  it("opens only existing targets inside an authorized Worktree", async () => {
    const target = path.join(root, "src", "app.ts");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "export {};\n");
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(outside, path.join(root, "escape"));
    const launchEditor = vi.fn(async () => {});
    const service = createService({
      getEditor: async () => "test-editor",
      launchEditor,
    });
    const scope = { cwd: root, runMode: "linux" as const };

    await expect(
      service.openInEditor({ ...scope, absolutePath: target }),
    ).resolves.toBe(true);
    expect(launchEditor).toHaveBeenCalledWith(
      "test-editor",
      await realpath(target),
    );
    await expect(
      service.openInEditor({
        ...scope,
        absolutePath: path.join(outside, "secret.txt"),
      }),
    ).rejects.toMatchObject({ code: "path_not_authorized" });
    await expect(
      service.openInEditor({
        ...scope,
        absolutePath: path.join(root, "escape", "secret.txt"),
      }),
    ).rejects.toMatchObject({ code: "path_symlink_escape" });
    await expect(
      service.openInEditor({
        cwd: outside,
        runMode: "linux",
        absolutePath: path.join(outside, "secret.txt"),
      }),
    ).rejects.toMatchObject({ code: "worktree_not_authorized" });
    service.dispose();
  });
});

function createService(
  overrides: Partial<ConstructorParameters<typeof FileService>[0]> = {},
): FileService {
  return new FileService({
    runtime: {
      listRunning: async () => [],
      write: async () => undefined,
    },
    getSession: async () => null,
    authorizeScope: async (scope) => scope.cwd === root,
    ...overrides,
  });
}
