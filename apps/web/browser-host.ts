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

export function createBrowserHostMiddleware(
  options: BrowserHostMiddlewareOptions,
): Connect.NextHandleFunction {
  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__soloe/ready") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({ ready: true, backend: options.backendUrl ?? null }),
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
    if (name === "soloe_token" && decodeURIComponent(value.join("=")) === expected) {
      return true;
    }
  }
  return false;
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
