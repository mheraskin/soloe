import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TrayClipboardImageWriter } from "./TrayClipboardImageWriter.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe("TrayClipboardImageWriter", () => {
  it("sends a bounded versioned image request to the Tray Host", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-clipboard-test-"));
    const endpoint = path.join(directory, "clipboard.sock");
    let request = "";
    const server = createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        request += chunk.toString("utf8");
        if (!request.includes("\n")) return;
        socket.end('{"ok":true}\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    await new TrayClipboardImageWriter(endpoint).writeImage({
      mimeType: "image/png",
      data: Buffer.from("png bytes"),
    });

    expect(JSON.parse(request.trim())).toEqual({
      version: 1,
      type: "write_image",
      mimeType: "image/png",
      dataBase64: Buffer.from("png bytes").toString("base64"),
    });
  });

  it("surfaces a native clipboard rejection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-clipboard-test-"));
    const endpoint = path.join(directory, "clipboard.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.end('{"ok":false,"error":"Wayland unavailable"}\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    cleanup.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    await expect(new TrayClipboardImageWriter(endpoint).writeImage({
      mimeType: "image/png",
      data: Buffer.from("png bytes"),
    })).rejects.toThrow("Wayland unavailable");
  });
});
