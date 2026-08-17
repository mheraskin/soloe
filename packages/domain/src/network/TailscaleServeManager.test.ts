import { describe, expect, it, vi } from "vitest";

import {
  TailscalePortForwardManager,
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
        TCP: { "443": { HTTPS: true } },
        Web: {
          "workstation.tail1234.ts.net:443": {
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
          TCP: { "443": { HTTPS: true } },
          Web: {
            "old-name.tail1234.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:4318" } },
            },
          },
        });
      }
      expect(args).toEqual([
        "serve",
        "--bg",
        "--yes",
        "--https=443",
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
        "--https=443",
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
        TCP: { "443": { HTTPS: true } },
        Web: {
          "workstation.tail1234.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
          },
        },
      });
    });

    await expect(new TailscaleServeManager({ run, targetUrl: TARGET }).ensure())
      .resolves.toMatchObject({
        state: "conflict",
        message: expect.stringContaining("443"),
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

describe("TailscalePortForwardManager", () => {
  it("uses a service that is already reachable on the Device address", async () => {
    const run = vi.fn(async (args: readonly string[]) =>
      args[0] === "status" ? selfStatus() : "{}"
    );
    const probe = vi.fn(async (host: string) => host === "workstation.tail1234.ts.net");

    await expect(new TailscalePortForwardManager({ run, probe }).ensure(3000))
      .resolves.toEqual({
        state: "ready",
        message: null,
        setupUrl: null,
        dnsName: "workstation.tail1234.ts.net",
        port: 3000,
        forwarded: false,
      });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("publishes a loopback-only listener as a raw TCP forward", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") return selfStatus();
      if (args[1] === "status") return "{}";
      expect(args).toEqual([
        "serve",
        "--bg",
        "--yes",
        "--tcp=3000",
        "tcp://127.0.0.1:3000",
      ]);
      return "Available within your tailnet";
    });
    const probe = vi.fn(async (host: string) => host === "127.0.0.1");

    await expect(new TailscalePortForwardManager({ run, probe }).ensure(3000))
      .resolves.toMatchObject({
        state: "ready",
        dnsName: "workstation.tail1234.ts.net",
        port: 3000,
        forwarded: true,
      });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("reuses its exact existing forward without overwriting Serve", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") return selfStatus();
      return JSON.stringify({ TCP: { "3000": { TCPForward: "127.0.0.1:3000" } } });
    });

    await expect(new TailscalePortForwardManager({ run }).ensure(3000))
      .resolves.toMatchObject({ state: "ready", forwarded: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not replace another Serve route on the requested port", async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") return selfStatus();
      return JSON.stringify({ TCP: { "3000": { TCPForward: "127.0.0.1:4000" } } });
    });

    await expect(new TailscalePortForwardManager({ run }).ensure(3000))
      .resolves.toMatchObject({ state: "conflict", forwarded: false });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports when no local service owns the requested port", async () => {
    const run = vi.fn(async (args: readonly string[]) =>
      args[0] === "status" ? selfStatus() : "{}"
    );

    await expect(new TailscalePortForwardManager({
      run,
      probe: async () => false,
    }).ensure(3000)).resolves.toMatchObject({
      state: "error",
      message: "Nothing is listening on localhost:3000 on this Device.",
      forwarded: false,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
