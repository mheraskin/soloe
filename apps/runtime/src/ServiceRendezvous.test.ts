import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  removeServiceInfo,
  serviceInfoPath,
  loadOrCreateServerToken,
  writeServiceInfo,
} from "./ServiceRendezvous.js";

describe("service rendezvous", () => {
  it("publishes discovery information and only lets its owner remove it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-rendezvous-"));
    const file = serviceInfoPath(directory, "runtime");

    try {
      await writeServiceInfo(directory, {
        service: "runtime",
        pid: 123,
        startedAt: "2026-07-30T10:00:00.000Z",
        ownerId: "tray-owner",
        endpoint: "/tmp/runtime.sock",
      });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        service: "runtime",
        pid: 123,
        startedAt: "2026-07-30T10:00:00.000Z",
        ownerId: "tray-owner",
        endpoint: "/tmp/runtime.sock",
      });

      await removeServiceInfo(directory, "runtime", 456, "tray-owner");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
        expect.objectContaining({ pid: 123 }),
      );

      await removeServiceInfo(directory, "runtime", 123, "wrong-owner");
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
        expect.objectContaining({ ownerId: "tray-owner" }),
      );

      await removeServiceInfo(directory, "runtime", 123, "tray-owner");
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the browser service token stable across server replacements", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-token-"));
    try {
      const first = await loadOrCreateServerToken(directory);
      const second = await loadOrCreateServerToken(directory);
      expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(second).toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
