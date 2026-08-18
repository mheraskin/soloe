import { describe, expect, it, vi } from "vitest";
import { SystemClipboardImageWriter } from "./SystemClipboardImageWriter.js";

describe("SystemClipboardImageWriter", () => {
  it("writes Wayland image bytes with their native MIME type", async () => {
    const run = vi.fn(async () => undefined);
    const writer = new SystemClipboardImageWriter({
      platform: "linux",
      environment: { WAYLAND_DISPLAY: "wayland-0" },
      commands: { run },
    });
    const data = Buffer.from("png bytes");

    await writer.writeImage({ mimeType: "image/png", data });

    expect(run).toHaveBeenCalledWith(
      "wl-copy",
      ["--type", "image/png"],
      data,
    );
  });

  it("falls back from the X11 clipboard command to Wayland", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("xclip missing"))
      .mockResolvedValueOnce(undefined);
    const writer = new SystemClipboardImageWriter({
      platform: "linux",
      environment: {},
      commands: { run },
    });
    const data = Buffer.from("png bytes");

    await writer.writeImage({ mimeType: "image/png", data });

    expect(run).toHaveBeenNthCalledWith(
      1,
      "xclip",
      ["-selection", "clipboard", "-t", "image/png", "-i"],
      data,
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "wl-copy",
      ["--type", "image/png"],
      data,
    );
  });

  it("uses the Windows host clipboard for a WSL owning Device", async () => {
    const run = vi.fn(async () => undefined);
    const writer = new SystemClipboardImageWriter({
      platform: "linux",
      environment: { WSL_DISTRO_NAME: "Ubuntu" },
      commands: { run },
    });
    const data = Buffer.from("png bytes");

    await writer.writeImage({ mimeType: "image/png", data });

    expect(run).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-Sta", "-Command"]),
      data.toString("base64"),
    );
  });
});
