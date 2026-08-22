import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserRouteProxy } from "./BrowserRouteProxy.js";

describe("BrowserRouteProxy", () => {
  it("forwards requests to loopback while preserving the original virtual host", async () => {
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
        virtualHostname: "ember-oak.xps.example.ts.net",
      });
      const response = await fetch(`http://127.0.0.1:${route.port}/order-ahead/?menu=lunch`);

      await expect(response.json()).resolves.toEqual({
        host: `ember-oak.xps.example.ts.net:${address.port}`,
        url: "/order-ahead/?menu=lunch",
      });
      await expect(routes.ensure({
        targetPort: address.port,
        virtualHostname: "ember-oak.xps.example.ts.net",
      })).resolves.toEqual(route);

      const socket = new WebSocket(`ws://127.0.0.1:${route.port}/hmr`);
      const message = await new Promise<string>((resolve, reject) => {
        socket.once("message", (data) => resolve(data.toString()));
        socket.once("error", reject);
      });
      expect(JSON.parse(message)).toEqual({
        host: `ember-oak.xps.example.ts.net:${address.port}`,
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
});
