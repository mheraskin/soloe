import { createServer, request as requestHttp } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserRouteProxy } from "./BrowserRouteProxy.js";

describe("BrowserRouteProxy", () => {
  it("shares one target-port proxy while preserving each incoming virtual host", async () => {
    const upstream = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ host: request.headers.host, url: request.url }));
    });
    const webSockets = new WebSocketServer({ server: upstream });
    webSockets.on("connection", (socket, request) => {
      socket.send(JSON.stringify({ host: request.headers.host, url: request.url }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not bind");
    const routes = new BrowserRouteProxy();

    try {
      const route = await routes.ensure({
        targetPort: address.port,
        virtualHostname: "ember-oak.xps",
      });
      const response = await new Promise<string>((resolve, reject) => {
        const request = requestHttp({
          hostname: "127.0.0.1",
          port: route.port,
          path: "/order-ahead/?menu=lunch",
          headers: { host: `ember-oak.xps:${address.port}` },
        }, (result) => {
          const chunks: Buffer[] = [];
          result.on("data", (chunk: Buffer) => chunks.push(chunk));
          result.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        request.once("error", reject);
        request.end();
      });

      expect(JSON.parse(response)).toEqual({
        host: `ember-oak.xps:${address.port}`,
        url: "/order-ahead/?menu=lunch",
      });
      const apexRoute = await routes.ensure({
        targetPort: address.port,
        virtualHostname: "xps",
      });
      expect(apexRoute).toEqual({
        ...route,
        virtualHostname: "xps",
      });

      const socket = new WebSocket(`ws://127.0.0.1:${route.port}/hmr`, {
        headers: { host: `ember-oak.xps:${address.port}` },
      });
      const message = await new Promise<string>((resolve, reject) => {
        socket.once("message", (data) => resolve(data.toString()));
        socket.once("error", reject);
      });
      expect(JSON.parse(message)).toEqual({
        host: `ember-oak.xps:${address.port}`,
        url: "/hmr",
      });
      socket.close();
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    } finally {
      await routes.dispose();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => upstream.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });

  it("restores the intended virtual host when a nip.io fallback reaches the proxy", async () => {
    const upstream = createServer((request, response) => {
      response.end(request.headers.host);
    });
    const targetPort = await listen(upstream);
    const routes = new BrowserRouteProxy();
    try {
      const route = await routes.ensure({ targetPort, virtualHostname: "ember-oak.xps" });
      const body = await get(route.port, "ember-oak.xps.100-99-182-95.nip.io:8877");
      expect(body).toBe("ember-oak.xps:8877");
    } finally {
      await routes.dispose();
      await close(upstream);
    }
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("server did not bind"));
      else resolve(address.port);
    });
  });
}

function get(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = requestHttp({ hostname: "127.0.0.1", port, headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.once("error", reject);
    request.end();
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
