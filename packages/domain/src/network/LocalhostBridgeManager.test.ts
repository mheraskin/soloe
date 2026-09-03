import { createConnection, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LocalhostBridgeManager } from "./LocalhostBridgeManager.js";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

describe("LocalhostBridgeManager", () => {
  const managers: LocalhostBridgeManager[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.allSettled(managers.map((manager) => manager.dispose()));
    await Promise.allSettled(servers.map(closeServer));
    managers.length = 0;
    servers.length = 0;
  });

  it("forwards TCP in both directions through a loopback-only listener", async () => {
    const upstream = createServer((socket) => {
      socket.on("data", (data) => socket.write(Buffer.from(`remote:${data}`)));
    });
    servers.push(upstream);
    const remotePort = await listen(upstream);
    const localPort = await availablePort();
    const manager = new LocalhostBridgeManager();
    managers.push(manager);

    await expect(manager.open({
      deviceId: DEVICE_A,
      deviceName: "xps",
      localPort,
      remoteHost: "127.0.0.1",
      remotePort,
    })).resolves.toEqual({
      deviceId: DEVICE_A,
      deviceName: "xps",
      port: localPort,
      localAddress: "127.0.0.1",
    });

    await expect(roundTrip(localPort, "hello")).resolves.toBe("remote:hello");
  });

  it("is idempotent for the same Device and rejects another Device on that port", async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    servers.push(upstream);
    const remotePort = await listen(upstream);
    const localPort = await availablePort();
    const manager = new LocalhostBridgeManager();
    managers.push(manager);
    const target = {
      deviceId: DEVICE_A,
      deviceName: "xps",
      localPort,
      remoteHost: "127.0.0.1",
      remotePort,
    };

    const first = await manager.open(target);
    const second = await manager.open(target);

    expect(second).toEqual(first);
    await expect(manager.open({ ...target, deviceId: DEVICE_B, deviceName: "other" }))
      .rejects.toThrow(`localhost:${localPort} is already mapped to xps.`);
    expect(manager.list()).toEqual([first]);
  });

  it("releases the local port on close and rejects work after disposal", async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    servers.push(upstream);
    const remotePort = await listen(upstream);
    const localPort = await availablePort();
    const manager = new LocalhostBridgeManager();
    managers.push(manager);

    await manager.open({
      deviceId: DEVICE_A,
      deviceName: "xps",
      localPort,
      remoteHost: "127.0.0.1",
      remotePort,
    });
    await manager.close(localPort);

    expect(manager.list()).toEqual([]);
    const replacement = createServer();
    servers.push(replacement);
    await expect(listen(replacement, localPort)).resolves.toBe(localPort);

    await manager.dispose();
    await expect(manager.open({
      deviceId: DEVICE_A,
      deviceName: "xps",
      localPort: await availablePort(),
      remoteHost: "127.0.0.1",
      remotePort,
    })).rejects.toThrow("Localhost bridges have been disposed.");
  });

  it("reports a local port collision without replacing its owner", async () => {
    const occupied = createServer();
    servers.push(occupied);
    const localPort = await listen(occupied);
    const manager = new LocalhostBridgeManager();
    managers.push(manager);

    await expect(manager.open({
      deviceId: DEVICE_A,
      deviceName: "xps",
      localPort,
      remoteHost: "127.0.0.1",
      remotePort: 8971,
    })).rejects.toThrow(`localhost:${localPort} is already in use on this Device.`);
    expect(manager.list()).toEqual([]);
  });
});

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP listener."));
        return;
      }
      resolve(address.port);
    });
  });
}

async function availablePort(): Promise<number> {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  return port;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function roundTrip(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(message));
    socket.once("data", (data) => {
      resolve(String(data));
      socket.destroy();
    });
  });
}
