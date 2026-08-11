import path from "node:path";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveRuntimeEndpoint } from "./RuntimeEndpoint.js";
import { prepareRuntimeEndpoint } from "./RuntimeSocket.js";

describe("resolveRuntimeEndpoint", () => {
  it("uses a stable socket inside the Soloe data directory on Unix", () => {
    expect(
      resolveRuntimeEndpoint({
        platform: "linux",
        dataDirectory: "/var/lib/soloe-user",
      }),
    ).toBe(path.join("/var/lib/soloe-user", "runtime.sock"));
  });

  it("uses a named pipe on Windows", () => {
    expect(
      resolveRuntimeEndpoint({
        platform: "win32",
        dataDirectory: "C:\\Users\\solo\\AppData\\Local\\Soloe",
        userIdentity: "solo.user",
      }),
    ).toBe("\\\\.\\pipe\\soloe-runtime-solo-user");
  });

  it("removes a stale Unix socket path before startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-stale-socket-"));
    const endpoint = path.join(directory, "runtime.sock");
    try {
      await writeFile(endpoint, "stale");
      await prepareRuntimeEndpoint(endpoint, "linux");
      await expect(stat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
