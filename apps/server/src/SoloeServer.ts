import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import { RuntimeClient } from "@soloe/runtime";

export interface SoloeServerOptions {
  runtimeEndpoint: string;
  host?: string;
  port?: number;
  token: string;
  webRoot?: string;
  rpcHandler?: (call: BrowserRpcCall) => Promise<unknown>;
}

export interface BrowserRpcCall {
  namespace: string;
  method: string;
  args: unknown[];
}

export class SoloeServer {
  private readonly options: {
    runtimeEndpoint: string;
    host: string;
    port: number;
    token: string;
    webRoot: string;
    rpcHandler?: (call: BrowserRpcCall) => Promise<unknown>;
  };
  private runtimeClient: RuntimeClient | undefined;
  private server: Server | undefined;
  private webSocketServer: WebSocketServer | undefined;
  private runtimeListeners: Array<{
    event: string;
    listener: (payload: unknown) => void;
  }> = [];

  constructor(options: SoloeServerOptions) {
    this.options = {
      runtimeEndpoint: options.runtimeEndpoint,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      token: options.token,
      webRoot: options.webRoot ?? "",
      ...(options.rpcHandler ? { rpcHandler: options.rpcHandler } : {}),
    };
  }

  async listen(): Promise<string> {
    if (this.server) {
      throw new Error("Soloe server is already listening");
    }

    const runtimeClient = await RuntimeClient.connect(this.options.runtimeEndpoint);
    const webSocketServer = new WebSocketServer({ noServer: true });
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
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
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "internal_server_error",
          }),
        );
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
    const runtimeListeners = ["output", "exit"].map((event) => {
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
      const call = await this.readJson<BrowserRpcCall>(request);
      try {
        this.json(response, 200, {
          ok: true,
          value: await this.options.rpcHandler(call),
        });
      } catch (error) {
        this.json(response, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
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

    this.json(response, 404, { error: "not_found" });
  }

  private async readJson<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
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

  private tokensMatch(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const expected = Buffer.from(this.options.token);
    const received = Buffer.from(candidate);
    return expected.length === received.length && timingSafeEqual(expected, received);
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
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        path.extname(relativePath)
      ) {
        this.json(response, 404, { error: "not_found" });
        return;
      }
      file = path.join(root, "index.html");
      body = await readFile(file);
    }
    response.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": path.basename(file) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    response.end(body);
  }
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
