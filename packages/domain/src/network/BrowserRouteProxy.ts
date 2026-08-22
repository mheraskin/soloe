import {
  createServer,
  request as requestHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { DomainError } from "../errors.js";

export interface BrowserRouteRequest {
  targetPort: number;
  virtualHostname: string;
}

export interface BrowserRoute {
  port: number;
  targetPort: number;
  virtualHostname: string;
}

interface ActiveRoute {
  server: Server;
  sockets: Set<Socket>;
  port: number;
  targetPort: number;
}

const ROUTE_PORT_START = 40_000;
const ROUTE_PORT_COUNT = 20_000;

/**
 * Gives every development-server port one loopback listener. Tailscale
 * publishes that listener on the original public port, while this proxy keeps
 * the browser's Host header intact for both the Device apex and its subdomains.
 */
export class BrowserRouteProxy {
  private readonly routes = new Map<string, Promise<ActiveRoute>>();

  async ensure(request: BrowserRouteRequest): Promise<BrowserRoute> {
    const targetPort = validPort(request.targetPort);
    const virtualHostname = validHostname(request.virtualHostname);
    const key = String(targetPort);
    let route = this.routes.get(key);
    if (!route) {
      route = this.createRoute(targetPort);
      this.routes.set(key, route);
      void route.catch(() => {
        if (this.routes.get(key) === route) this.routes.delete(key);
      });
    }
    const active = await route;
    return {
      port: active.port,
      targetPort: active.targetPort,
      virtualHostname,
    };
  }

  async dispose(): Promise<void> {
    const routes = [...this.routes.values()];
    this.routes.clear();
    await Promise.all(routes.map(async (route) => {
      const active = await route.catch(() => null);
      if (!active) return;
      for (const socket of active.sockets) socket.destroy();
      await new Promise<void>((resolve) => active.server.close(() => resolve()));
    }));
  }

  private async createRoute(targetPort: number): Promise<ActiveRoute> {
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      proxyRequest(request, response, targetPort);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      proxyUpgrade(request, socket, head, targetPort);
    });
    await listenOnStableRoutePort(server, String(targetPort));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Browser route proxy did not bind to a TCP port");
    }
    return { server, sockets, port: address.port, targetPort };
  }
}

async function listenOnStableRoutePort(server: Server, key: string): Promise<void> {
  const first = hashRouteKey(key) % ROUTE_PORT_COUNT;
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const port = ROUTE_PORT_START + ((first + attempt) % ROUTE_PORT_COUNT);
    try {
      await listen(server, port);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No stable browser route proxy port is available");
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function hashRouteKey(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  targetPort: number,
): void {
  const headers = rewriteFallbackHost(request.headers);
  const upstream = requestHttp({
    hostname: "127.0.0.1",
    port: targetPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("The routed development server is unavailable.");
  });
  request.pipe(upstream);
}

function proxyUpgrade(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  targetPort: number,
): void {
  const upstream = connect(targetPort, "127.0.0.1");
  upstream.once("connect", () => {
    const rewrittenHost = fallbackVirtualHost(request.headers.host);
    const headers = request.rawHeaders.flatMap((value, index, all) => {
      if (index % 2 !== 0) return [];
      return [`${value}: ${value.toLowerCase() === "host" && rewrittenHost ? rewrittenHost : (all[index + 1] ?? "")}`];
    });
    upstream.write([
      `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`,
      ...headers,
      "",
      "",
    ].join("\r\n"));
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  const fail = () => client.destroy();
  upstream.once("error", fail);
  client.once("error", () => upstream.destroy());
}

function rewriteFallbackHost(headers: IncomingMessage["headers"]): IncomingMessage["headers"] {
  const host = fallbackVirtualHost(headers.host);
  return host ? { ...headers, host } : headers;
}

function fallbackVirtualHost(host: string | undefined): string | null {
  if (!host) return null;
  const match = /^(?<virtual>.+)\.(?:\d{1,3}-){3}\d{1,3}\.nip\.io(?<port>:\d+)?$/iu.exec(host);
  return match?.groups?.["virtual"]
    ? `${match.groups["virtual"]}${match.groups["port"] ?? ""}`
    : null;
}

function validPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new DomainError("invalid_network_port", "Browser route port is invalid");
  }
  return value;
}

function validHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (
    !hostname
    || hostname.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)
  ) {
    throw new DomainError("invalid_browser_hostname", "Browser route hostname is invalid");
  }
  return hostname;
}
