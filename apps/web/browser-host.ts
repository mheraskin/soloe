import type { Connect } from "vite";

export interface BrowserHostMiddlewareOptions {
  backendUrl: string | undefined;
  token: string | undefined;
  allowedTailscaleUsers?: string | undefined;
}

interface TailscaleIdentityOptions {
  header: string | string[] | undefined;
  remoteAddress: string | undefined;
  allowedUsers?: string | undefined;
}

export function resolveBrowserHostAllowedHosts(
  configuredHosts: string | undefined,
): string[] {
  const allowedHosts: string[] = [];
  for (const entry of configuredHosts?.split(",") ?? []) {
    const hostname = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!hostname) continue;
    if (!isExplicitHostname(hostname)) {
      throw new Error(`Invalid Soloe browser host: ${entry.trim()}`);
    }
    if (!allowedHosts.includes(hostname)) allowedHosts.push(hostname);
  }
  return allowedHosts;
}

export function createBrowserHostMiddleware(
  options: BrowserHostMiddlewareOptions,
): Connect.NextHandleFunction {
  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__soloe/ready") {
      const ready = Boolean(options.backendUrl && options.token);
      response.writeHead(ready ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({ ready, backend: options.backendUrl ?? null }),
      );
      return;
    }

    if (!options.token || !options.backendUrl) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "browser_host_not_configured",
            message: "The Soloe browser host was not started by the Windows tray",
          },
        }),
      );
      return;
    }

    if (url.pathname === "/" && url.searchParams.get("token") === options.token) {
      redirectWithSession(response, options.token, false);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/__soloe/auth/tailscale"
    ) {
      if (authorized(request.headers.cookie, options.token)) {
        respondAuthenticated(response);
        return;
      }
      const identity = trustedTailscaleIdentity({
        header: request.headers["tailscale-user-login"],
        remoteAddress: request.socket.remoteAddress,
        allowedUsers: options.allowedTailscaleUsers,
      });
      if (identity) {
        respondWithSession(response, options.token);
        return;
      }
    }

    if (authorized(request.headers.cookie, options.token)) {
      next();
      return;
    }

    const tailscaleIdentity = trustedTailscaleIdentity({
      header: request.headers["tailscale-user-login"],
      remoteAddress: request.socket.remoteAddress,
      allowedUsers: options.allowedTailscaleUsers,
    });
    if (url.pathname === "/" && tailscaleIdentity) {
      redirectWithSession(response, options.token, true);
      return;
    }

    response.writeHead(401, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        error: {
          code: "unauthorized",
          message: "Open Soloe from the tray or use an authorized Tailscale account",
        },
      }),
    );
  };
}

export function trustedTailscaleIdentity(
  options: TailscaleIdentityOptions,
): string | null {
  if (!isLoopback(options.remoteAddress) || typeof options.header !== "string") {
    return null;
  }
  const identity = options.header.trim();
  if (!identity) return null;
  if (options.allowedUsers === undefined) return identity;

  const normalizedIdentity = identity.toLowerCase();
  const allowlist = new Set(
    options.allowedUsers
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowlist.has(normalizedIdentity) ? identity : null;
}

function redirectWithSession(
  response: Parameters<Connect.NextHandleFunction>[1],
  token: string,
  secure: boolean,
): void {
  response.writeHead(302, {
    location: "/",
    "set-cookie": sessionCookie(token, secure),
    "cache-control": "no-store",
  });
  response.end();
}

function respondWithSession(
  response: Parameters<Connect.NextHandleFunction>[1],
  token: string,
): void {
  response.writeHead(204, {
    "set-cookie": sessionCookie(token, true),
    "cache-control": "no-store",
  });
  response.end();
}

function respondAuthenticated(
  response: Parameters<Connect.NextHandleFunction>[1],
): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function sessionCookie(token: string, secure: boolean): string {
  return [
    `soloe_token=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function authorized(cookieHeader: string | undefined, expected: string): boolean {
  for (const cookie of cookieHeader?.split(";") ?? []) {
    const [name, ...value] = cookie.trim().split("=");
    if (name !== "soloe_token") continue;
    try {
      if (decodeURIComponent(value.join("=")) === expected) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function isExplicitHostname(hostname: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
    hostname,
  );
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  );
}
