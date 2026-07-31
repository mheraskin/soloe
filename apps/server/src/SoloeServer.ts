import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import { RuntimeClient } from "@soloe/runtime";

const MAX_JSON_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RPC_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface SoloeServerOptions {
  runtimeEndpoint: string;
  host?: string;
  port?: number;
  token: string;
  webRoot?: string;
  rpcHandler?: (call: BrowserRpcCall) => Promise<unknown>;
  clientDisconnected?: (clientId: string) => void;
  clientReconnected?: (clientId: string) => void;
  clientDisconnectGraceMs?: number;
}

export interface BrowserRpcCall {
  namespace: string;
  method: string;
  args: unknown[];
  clientId?: string;
}

export class SoloeServer {
  private readonly options: {
    runtimeEndpoint: string;
    host: string;
    port: number;
    token: string;
    webRoot: string;
    rpcHandler?: (call: BrowserRpcCall) => Promise<unknown>;
    clientDisconnected?: (clientId: string) => void;
    clientReconnected?: (clientId: string) => void;
    clientDisconnectGraceMs: number;
  };
  private runtimeClient: RuntimeClient | undefined;
  private server: Server | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private runtimeListeners: Array<{
    event: string;
    listener: (payload: unknown) => void;
  }> = [];
  private readonly clientSocketCounts = new Map<string, number>();
  private readonly socketClientIds = new WeakMap<WebSocket, string>();
  private readonly clientDisconnectTimers = new Map<string, NodeJS.Timeout>();
  private closing = false;

  constructor(options: SoloeServerOptions) {
    this.options = {
      runtimeEndpoint: options.runtimeEndpoint,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      token: options.token,
      webRoot: options.webRoot ?? "",
      ...(options.rpcHandler ? { rpcHandler: options.rpcHandler } : {}),
      ...(options.clientDisconnected
        ? { clientDisconnected: options.clientDisconnected }
        : {}),
      ...(options.clientReconnected
        ? { clientReconnected: options.clientReconnected }
        : {}),
      clientDisconnectGraceMs: options.clientDisconnectGraceMs ?? 5_000,
    };
  }

  async listen(): Promise<string> {
    if (this.server) {
      throw new Error("Soloe server is already listening");
    }
    this.closing = false;

    const runtimeClient = await RuntimeClient.connect(this.options.runtimeEndpoint);
    const webSocketServer = new WebSocketServer({ noServer: true });
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const rpcOrigin =
          url.pathname === "/api/rpc"
            ? this.allowedRendererOrigin(request.headers.origin)
            : null;
        if (rpcOrigin) {
          this.applyRpcCors(response, rpcOrigin);
        }
        if (request.method === "OPTIONS" && url.pathname === "/api/rpc") {
          if (!rpcOrigin || !this.isAllowedRpcPreflight(request)) {
            this.json(response, 403, { error: "cors_origin_rejected" });
            return;
          }
          response.writeHead(204).end();
          return;
        }
        if (
          request.method === "GET" &&
          url.pathname === "/" &&
          this.tokensMatch(url.searchParams.get("token"))
        ) {
          response.writeHead(302, {
            location: "/",
            "set-cookie": `soloe_token=${encodeURIComponent(this.options.token)}; HttpOnly; SameSite=Strict; Path=/`,
          });
          response.end();
          return;
        }
        if (url.pathname.startsWith("/api/") && !this.isAuthorized(request)) {
          this.json(response, 401, { error: "unauthorized" });
          return;
        }
        await this.handleRequest(runtimeClient, request, response);
      } catch (error) {
        const failure = httpFailure(error);
        this.json(response, failure.status, {
          error: {
            code: failure.code,
            message: failure.message,
            ...(failure.remediation
              ? { remediation: failure.remediation }
              : {}),
          },
        });
      }
    });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/api/runtime/events") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (
        !this.isAuthorized(request) &&
        !this.tokensMatch(url.searchParams.get("token"))
      ) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (webSocket, request) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const rawClientId = url.searchParams.get("clientId");
      const clientId = validClientId(rawClientId);
      if (rawClientId !== null && !clientId) {
        webSocket.close(1008, "invalid client identity");
        return;
      }
      if (!clientId) return;
      const timer = this.clientDisconnectTimers.get(clientId);
      const reconnected = Boolean(timer);
      if (timer) {
        clearTimeout(timer);
        this.clientDisconnectTimers.delete(clientId);
      }
      this.socketClientIds.set(webSocket, clientId);
      this.clientSocketCounts.set(
        clientId,
        (this.clientSocketCounts.get(clientId) ?? 0) + 1,
      );
      webSocket.once("close", () => this.releaseClientSocket(clientId));
      if (reconnected) this.options.clientReconnected?.(clientId);
    });
    const runtimeListeners = ["output", "exit", "location"].map((event) => {
      const listener = (payload: unknown) => this.publish(event, payload);
      runtimeClient.on(event, listener);
      return { event, listener };
    });

    await new Promise<void>((resolve, reject) => {
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
      server.listen(this.options.port, this.options.host);
    }).catch((error) => {
      for (const { event, listener } of runtimeListeners) {
        runtimeClient.off(event, listener);
      }
      webSocketServer.close();
      runtimeClient.disconnect();
      throw error;
    });

    this.runtimeClient = runtimeClient;
    this.server = server;
    this.webSocketServer = webSocketServer;
    this.runtimeListeners = runtimeListeners;

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Soloe server did not bind to a TCP address");
    }

    return `http://${this.options.host}:${address.port}`;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.clientDisconnectTimers.values()) clearTimeout(timer);
    this.clientDisconnectTimers.clear();
    this.clientSocketCounts.clear();
    const server = this.server;
    this.server = undefined;
    const webSocketServer = this.webSocketServer;
    this.webSocketServer = undefined;

    if (this.runtimeClient) {
      for (const { event, listener } of this.runtimeListeners) {
        this.runtimeClient.off(event, listener);
      }
    }
    this.runtimeListeners = [];

    if (webSocketServer) {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      webSocketServer.close();
    }

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    this.runtimeClient?.disconnect();
    this.runtimeClient = undefined;
  }

  publish(event: string, payload: unknown): void {
    if (!this.webSocketServer) return;
    const message = JSON.stringify({ event, payload });
    for (const client of this.webSocketServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  publishToClient(clientId: string, event: string, payload: unknown): void {
    if (!this.webSocketServer) return;
    const message = JSON.stringify({ event, payload });
    for (const client of this.webSocketServer.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        this.socketClientIds.get(client) === clientId
      ) {
        client.send(message);
      }
    }
  }

  private async handleRequest(
    runtimeClient: RuntimeClient,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api/runtime/sessions") {
      if (request.method === "GET") {
        this.json(response, 200, await runtimeClient.listRunning());
        return;
      }
      if (request.method === "POST") {
        this.json(response, 201, await runtimeClient.start(await this.readJson(request)));
        return;
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/rpc" &&
      this.options.rpcHandler
    ) {
      const call = validateRpcCall(await this.readJson<unknown>(request));
      const requestBytes = Buffer.byteLength(JSON.stringify(call));
      const startedAt = performance.now();
      this.logRpc({
        event: "rpc_start",
        namespace: call.namespace,
        method: call.method,
        requestBytes,
      });
      try {
        const result = {
          ok: true,
          value: await this.options.rpcHandler(call),
        } as const;
        const responseBytes = Buffer.byteLength(JSON.stringify(result));
        if (responseBytes > MAX_RPC_RESPONSE_BYTES) {
          throw new RpcTransportError(
            "response_too_large",
            `RPC response exceeds the ${MAX_RPC_RESPONSE_BYTES}-byte limit`,
            413,
            "Narrow the request or use a bounded result",
          );
        }
        this.json(response, 200, result);
        this.logRpc({
          event: "rpc_end",
          namespace: call.namespace,
          method: call.method,
          outcome: "ok",
          durationMs: elapsedMilliseconds(startedAt),
          requestBytes,
          responseBytes,
        });
      } catch (error) {
        const failure = rpcFailure(error);
        const result = {
          ok: false,
          ...failure,
        } as const;
        const responseBytes = Buffer.byteLength(JSON.stringify(result));
        this.json(response, 200, result);
        this.logRpc({
          event: "rpc_end",
          namespace: call.namespace,
          method: call.method,
          outcome: "error",
          durationMs: elapsedMilliseconds(startedAt),
          requestBytes,
          responseBytes,
          code: failure.code,
        });
      }
      return;
    }

    const terminalRoute = url.pathname.match(
      /^\/api\/runtime\/terminals\/([^/]+)(?:\/(replay|input|resize))?$/,
    );
    if (terminalRoute) {
      const terminalId = decodeURIComponent(terminalRoute[1]!);
      const operation = terminalRoute[2];

      if (request.method === "GET" && operation === "replay") {
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
        this.json(response, 200, await runtimeClient.replay(terminalId, afterSeq));
        return;
      }
      if (request.method === "POST" && operation === "input") {
        const body = await this.readJson<{ data: string }>(request);
        await runtimeClient.write(terminalId, body.data);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && operation === "resize") {
        const body = await this.readJson<{ cols: number; rows: number }>(request);
        await runtimeClient.resize(terminalId, body.cols, body.rows);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "DELETE" && operation === undefined) {
        await runtimeClient.stop(terminalId);
        response.writeHead(204).end();
        return;
      }
    }

    if (request.method === "GET" && this.options.webRoot) {
      await this.serveWebClient(url, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      this.browserUnavailable(response);
      return;
    }

    this.json(response, 404, { error: "not_found" });
  }

  private async readJson<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_JSON_REQUEST_BYTES) {
        throw new RpcTransportError(
          "request_too_large",
          `JSON request exceeds the ${MAX_JSON_REQUEST_BYTES}-byte limit`,
          413,
          "Send a smaller request",
        );
      }
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new RpcTransportError(
        "invalid_json",
        "Request body is not valid JSON",
        400,
      );
    }
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (
      typeof authorization === "string" &&
      authorization.startsWith("Bearer ") &&
      this.tokensMatch(authorization.slice("Bearer ".length))
    ) {
      return true;
    }
    const cookies = request.headers.cookie?.split(";") ?? [];
    for (const cookie of cookies) {
      const [name, ...parts] = cookie.trim().split("=");
      if (
        name === "soloe_token" &&
        this.tokensMatch(decodeURIComponent(parts.join("=")))
      ) {
        return true;
      }
    }
    return false;
  }

  private allowedRendererOrigin(origin: string | undefined): string | null {
    if (!origin) return null;
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:") return null;
      if (
        url.hostname !== "localhost" &&
        url.hostname !== "127.0.0.1" &&
        url.hostname !== "[::1]"
      ) {
        return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  }

  private isAllowedRpcPreflight(request: IncomingMessage): boolean {
    if (request.headers["access-control-request-method"] !== "POST") {
      return false;
    }
    const requestedHeaders = String(
      request.headers["access-control-request-headers"] ?? "",
    )
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    return requestedHeaders.every(
      (header) => header === "authorization" || header === "content-type",
    );
  }

  private applyRpcCors(response: ServerResponse, origin: string): void {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "POST");
    response.setHeader(
      "access-control-allow-headers",
      "Authorization, Content-Type",
    );
    response.setHeader("vary", "Origin");
  }

  private tokensMatch(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const expected = Buffer.from(this.options.token);
    const received = Buffer.from(candidate);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private logRpc(entry: {
    event: "rpc_start" | "rpc_end";
    namespace: string;
    method: string;
    requestBytes: number;
    outcome?: "ok" | "error";
    durationMs?: number;
    responseBytes?: number;
    code?: string;
  }): void {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        service: "application-server",
        severity: entry.outcome === "error" ? "error" : "info",
        ...entry,
      })}\n`,
    );
  }

  private releaseClientSocket(clientId: string): void {
    const remaining = (this.clientSocketCounts.get(clientId) ?? 1) - 1;
    if (remaining > 0) {
      this.clientSocketCounts.set(clientId, remaining);
      return;
    }
    this.clientSocketCounts.delete(clientId);
    if (this.closing || !this.options.clientDisconnected) return;
    const timer = setTimeout(() => {
      this.clientDisconnectTimers.delete(clientId);
      if (!this.clientSocketCounts.has(clientId)) {
        this.options.clientDisconnected?.(clientId);
      }
    }, this.options.clientDisconnectGraceMs);
    timer.unref();
    this.clientDisconnectTimers.set(clientId, timer);
  }

  private async serveWebClient(url: URL, response: ServerResponse): Promise<void> {
    const root = path.resolve(this.options.webRoot);
    const requestedPath = decodeURIComponent(url.pathname);
    const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
    const candidate = path.resolve(root, relativePath);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      this.json(response, 404, { error: "not_found" });
      return;
    }

    let file = candidate;
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (requestedPath === "/") {
        this.browserUnavailable(response);
        return;
      }
      if (path.extname(relativePath)) {
        this.json(response, 404, { error: "not_found" });
        return;
      }
      file = path.join(root, "index.html");
      try {
        body = await readFile(file);
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === "ENOENT") {
          this.browserUnavailable(response);
          return;
        }
        throw fallbackError;
      }
    }
    response.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": path.basename(file) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    response.end(body);
  }

  private browserUnavailable(response: ServerResponse): void {
    this.json(response, 503, {
      error: {
        code: "browser_assets_missing",
        message: "The Soloe browser application is not available",
        remediation: "Start the Windows web client from the Soloe tray",
      },
    });
  }
}

class RpcTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = "RpcTransportError";
  }
}

function validateRpcCall(value: unknown): BrowserRpcCall {
  if (!value || typeof value !== "object") {
    throw malformedRpc();
  }
  const call = value as Partial<BrowserRpcCall>;
  if (
    typeof call.namespace !== "string" ||
    !/^[a-z][a-zA-Z0-9]{0,63}$/u.test(call.namespace) ||
    typeof call.method !== "string" ||
    !/^[a-z][a-zA-Z0-9]{0,63}$/u.test(call.method) ||
    !Array.isArray(call.args)
  ) {
    throw malformedRpc();
  }
  if (call.clientId !== undefined && !validClientId(call.clientId)) {
    throw malformedRpc();
  }
  return {
    namespace: call.namespace,
    method: call.method,
    args: call.args,
    ...(typeof call.clientId === "string" ? { clientId: call.clientId } : {}),
  };
}

function validClientId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value)
    ? value
    : null;
}

function malformedRpc(): RpcTransportError {
  return new RpcTransportError(
    "malformed_rpc_body",
    "RPC body must contain a valid namespace, method, and args array",
    400,
  );
}

function httpFailure(error: unknown): {
  status: number;
  code: string;
  message: string;
  remediation?: string;
} {
  if (error instanceof RpcTransportError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.remediation ? { remediation: error.remediation } : {}),
    };
  }
  return {
    status: 500,
    code: "internal_server_error",
    message: "The application server could not complete the request",
  };
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function rpcFailure(error: unknown): {
  error: string;
  code: string;
  remediation?: string;
} {
  if (error && typeof error === "object") {
    const value = error as {
      message?: unknown;
      code?: unknown;
      remediation?: unknown;
    };
    return {
      error: typeof value.message === "string" ? value.message : String(error),
      code: typeof value.code === "string" ? value.code : "rpc_failed",
      ...(typeof value.remediation === "string"
        ? { remediation: value.remediation }
        : {}),
    };
  }
  return { error: String(error), code: "rpc_failed" };
}

function contentType(file: string): string {
  switch (path.extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
  return "application/octet-stream";
  }
}
