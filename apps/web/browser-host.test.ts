import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createBrowserHostMiddleware,
  addTailscaleWildcardHost,
  resolveBrowserHostAllowedHosts,
  trustedTailscaleIdentity,
} from "./browser-host";

const backendUrl = "http://127.0.0.1:4317";
const token = "server-token";

describe("Soloe browser host authentication", () => {
  it("accepts only explicit normalized hostnames for the Tailscale proxy", () => {
    expect(
      resolveBrowserHostAllowedHosts(
        " LaptopLores.tail1ab873.ts.net. , review.example.com, laptoplores.tail1ab873.ts.net ",
      ),
    ).toEqual(["laptoplores.tail1ab873.ts.net", "review.example.com"]);
    expect(resolveBrowserHostAllowedHosts(undefined)).toEqual([]);
    expect(() => resolveBrowserHostAllowedHosts(".ts.net")).toThrow(
      "Invalid Soloe browser host",
    );
  });

  it("keeps Tailscale MagicDNS reachable when tray discovery is unavailable", () => {
    expect(addTailscaleWildcardHost([])).toEqual([".ts.net"]);
    expect(
      addTailscaleWildcardHost(["xps.tail1ab873.ts.net"]),
    ).toEqual(["xps.tail1ab873.ts.net", ".ts.net"]);
  });

  it("creates a native client session from a trusted Tailscale identity", () => {
    const response = request({
      method: "POST",
      path: "/__soloe/auth/tailscale",
      headers: { "tailscale-user-login": "owner@example.com" },
    });

    expect(response.status).toBe(204);
    expect(response.headers["set-cookie"]).toBe(
      "soloe_token=server-token; HttpOnly; SameSite=Strict; Path=/; Secure",
    );
    expect(response.body).toBe("");
  });

  it("accepts an existing native client session without requiring a new identity header", () => {
    const response = request({
      method: "POST",
      path: "/__soloe/auth/tailscale",
      headers: { cookie: "soloe_token=server-token" },
    });

    expect(response.status).toBe(204);
    expect(response.headers).toEqual({ "cache-control": "no-store" });
    expect(response.body).toBe("");
  });

  it("exchanges a trusted Tailscale identity for a secure browser session", () => {
    const response = request({
      headers: { "tailscale-user-login": "owner@example.com" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(response.headers["set-cookie"]).toBe(
      "soloe_token=server-token; HttpOnly; SameSite=Strict; Path=/; Secure",
    );
  });

  it("matches an explicitly allowed Tailscale user case-insensitively", () => {
    const response = request(
      { headers: { "tailscale-user-login": "OWNER@example.com" } },
      { allowedTailscaleUsers: "other@example.com, owner@example.com" },
    );

    expect(response.status).toBe(302);
  });

  it("rejects a Tailscale user outside the configured allowlist", () => {
    const response = request(
      { headers: { "tailscale-user-login": "shared-user@example.com" } },
      { allowedTailscaleUsers: "owner@example.com" },
    );

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: "unauthorized" },
    });
  });

  it("serves an authenticated Tailscale request without redirecting again", () => {
    const response = request({
      headers: {
        cookie: "soloe_token=server-token",
        "tailscale-user-login": "owner@example.com",
      },
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ authorized: true });
  });

  it("does not trust a spoofed identity from a non-loopback peer", () => {
    expect(
      trustedTailscaleIdentity({
        header: "owner@example.com",
        remoteAddress: "100.64.0.10",
      }),
    ).toBeNull();
  });

  it("rejects a malformed session cookie without failing the host middleware", () => {
    const response = request({
      headers: { cookie: "soloe_token=%" },
    });

    expect(response.status).toBe(401);
  });

  it("preserves the tray token bootstrap and authenticated cookie flow", () => {
    const bootstrap = request({ path: "/?token=server-token" });
    expect(bootstrap.status).toBe(302);
    expect(bootstrap.headers["set-cookie"]).toBe(
      "soloe_token=server-token; HttpOnly; SameSite=Strict; Path=/",
    );

    const authenticated = request({
      headers: { cookie: "soloe_token=server-token" },
    });
    expect(authenticated.status).toBe(200);
    expect(JSON.parse(authenticated.body)).toEqual({ authorized: true });
  });

  function request(
    requestOptions: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
    },
    middlewareOptions: { allowedTailscaleUsers?: string } = {},
  ): CapturedResponse {
    const middleware = createBrowserHostMiddleware({
      backendUrl,
      token,
      ...middlewareOptions,
    });
    const captured: CapturedResponse = { status: 0, headers: {}, body: "" };
    const incoming = {
      method: requestOptions.method ?? "GET",
      url: requestOptions.path ?? "/",
      headers: requestOptions.headers ?? {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const response = {
      writeHead(status: number, headers: Record<string, string>) {
        captured.status = status;
        captured.headers = headers;
        return response;
      },
      end(body?: string) {
        captured.body = body ?? "";
        return response;
      },
    } as unknown as ServerResponse;
    middleware(incoming, response, () => {
      captured.status = 200;
      captured.headers = { "content-type": "application/json" };
      captured.body = JSON.stringify({ authorized: true });
    });
    return captured;
  }
});

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
