import { describe, expect, it, vi } from "vitest";

import {
  TailscaleServeManager,
  tailscaleExecutableCandidates,
} from "./TailscaleServeManager.js";

const TARGET = "http://127.0.0.1:4317";
const SELF_DNS_NAME = "workstation.tail1234.ts.net.";

function selfStatus(): string {
  return JSON.stringify({ Self: { DNSName: SELF_DNS_NAME } });
}

describe("TailscaleServeManager", () => {
  it("keeps an exact Soloe route without reconfiguring Tailscale Serve", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") return selfStatus();
      expect(args).toEqual(["serve", "status", "--json"]);
      return JSON.stringify({
        TCP: { "4318": { HTTPS: true } },
        Web: {
          "workstation.tail1234.ts.net:4318": {
            Handlers: { "/": { Proxy: TARGET } },
          },
        },
      });
    });

    await expect(new TailscaleServeManager({ run, targetUrl: TARGET }).ensure())
      .resolves.toEqual({
        state: "ready",
        message: null,
        setupUrl: null,
      });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("refreshes Soloe's route after the Tailscale device hostname changes", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") return selfStatus();
      if (args[1] === "status") {
        return JSON.stringify({
          TCP: { "4318": { HTTPS: true } },
          Web: {
            "old-name.tail1234.ts.net:4318": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:4318" } },
            },
          },
        });
      }
      expect(args).toEqual([
        "serve",
        "--bg",
        "--yes",
        "--https=4318",
        TARGET,
      ]);
      return "Available within your tailnet";
    });

    await expect(new TailscaleServeManager({ run, targetUrl: TARGET }).ensure())
      .resolves.toEqual({
        state: "ready",
        message: null,
        setupUrl: null,
      });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("configures a free dedicated HTTPS port in the background", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") return selfStatus();
      if (args[0] === "serve" && args[1] === "status") return "{}";
      expect(args).toEqual([
        "serve",
        "--bg",
        "--yes",
        "--https=4318",
        TARGET,
      ]);
      return "Available within your tailnet";
    });

    await expect(new TailscaleServeManager({ run, targetUrl: TARGET }).ensure())
      .resolves.toEqual({
        state: "ready",
        message: null,
        setupUrl: null,
      });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("never overwrites another service using Soloe's dedicated port", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") return selfStatus();
      return JSON.stringify({
        TCP: { "4318": { HTTPS: true } },
        Web: {
          "workstation.tail1234.ts.net:4318": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
          },
        },
      });
    });

    await expect(new TailscaleServeManager({ run, targetUrl: TARGET }).ensure())
      .resolves.toMatchObject({
        state: "conflict",
        message: expect.stringContaining("4318"),
      });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("surfaces Tailscale's one-time HTTPS consent link", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") return selfStatus();
      if (args[1] === "status") return "{}";
      throw new Error(
        "To enable HTTPS, visit: https://login.tailscale.com/admin/machines/abc/serve",
      );
    });

    await expect(new TailscaleServeManager({ run, targetUrl: TARGET }).ensure())
      .resolves.toEqual({
        state: "setup-required",
        message: "Tailscale needs one-time approval before Soloe can connect devices.",
        setupUrl: "https://login.tailscale.com/admin/machines/abc/serve",
      });
  });

  it("distinguishes a missing Tailscale CLI", async () => {
    const error = new Error("missing") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    const run = vi.fn(async () => { throw error; });

    await expect(new TailscaleServeManager({ run, targetUrl: TARGET }).ensure())
      .resolves.toEqual({
        state: "unavailable",
        message: "Install Tailscale to connect this Soloe Device to other machines.",
        setupUrl: "https://tailscale.com/download",
      });
  });

  it("finds app-bundled Tailscale CLIs before falling back to PATH", () => {
    expect(tailscaleExecutableCandidates("darwin", {})).toEqual([
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "tailscale",
    ]);
    expect(tailscaleExecutableCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    })).toEqual([
      "C:\\Program Files\\Tailscale\\tailscale.exe",
      "C:\\Users\\me\\AppData\\Local\\Tailscale\\tailscale.exe",
      "tailscale",
    ]);
    expect(tailscaleExecutableCandidates("darwin", {
      SOLOE_TAILSCALE_CLI: "/opt/custom/tailscale",
    })).toEqual(["/opt/custom/tailscale"]);
  });
});
