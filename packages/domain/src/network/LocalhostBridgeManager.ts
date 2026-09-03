import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { LocalhostBridge } from "@shared/types/connections.js";
import type { DeviceId } from "@shared/types/devices.js";

const LOOPBACK_ADDRESS = "127.0.0.1" as const;

export interface LocalhostBridgeTarget {
  deviceId: DeviceId;
  deviceName: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

interface ActiveBridge {
  descriptor: LocalhostBridge;
  server: Server;
  sockets: Set<Socket>;
  target: LocalhostBridgeTarget;
}

interface OpeningBridge {
  deviceId: DeviceId;
  deviceName: string;
  promise: Promise<LocalhostBridge>;
}

/** Owns temporary, loopback-only TCP listeners on the controlling Device. */
export class LocalhostBridgeManager {
  private readonly bridges = new Map<number, ActiveBridge>();
  private readonly opening = new Map<number, OpeningBridge>();
  private disposed = false;

  list(): LocalhostBridge[] {
    return [...this.bridges.values()]
      .map(({ descriptor }) => structuredClone(descriptor))
      .sort((left, right) => left.port - right.port);
  }

  async open(rawTarget: LocalhostBridgeTarget): Promise<LocalhostBridge> {
    if (this.disposed) throw new Error("Localhost bridges have been disposed.");
    const target = normalizeTarget(rawTarget);
    const active = this.bridges.get(target.localPort);
    if (active) {
      assertSameOwner(active.descriptor, target);
      active.target = target;
      return structuredClone(active.descriptor);
    }
    const pending = this.opening.get(target.localPort);
    if (pending) {
      assertSameOwner(pending, target);
      return pending.promise;
    }

    const promise = this.start(target).finally(() => {
      if (this.opening.get(target.localPort)?.promise === promise) {
        this.opening.delete(target.localPort);
      }
    });
    this.opening.set(target.localPort, {
      deviceId: target.deviceId,
      deviceName: target.deviceName,
      promise,
    });
    return promise;
  }

  async close(rawPort: number): Promise<void> {
    const port = validPort(rawPort);
    await this.opening.get(port)?.promise.catch(() => undefined);
    const bridge = this.bridges.get(port);
    if (!bridge) return;
    this.bridges.delete(port);
    for (const socket of bridge.sockets) socket.destroy();
    bridge.sockets.clear();
    await closeServer(bridge.server);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.opening.values()].map(({ promise }) => promise));
    await Promise.all([...this.bridges.keys()].map((port) => this.close(port)));
  }

  private async start(target: LocalhostBridgeTarget): Promise<LocalhostBridge> {
    const descriptor: LocalhostBridge = {
      deviceId: target.deviceId,
      deviceName: target.deviceName,
      port: target.localPort,
      localAddress: LOOPBACK_ADDRESS,
    };
    const sockets = new Set<Socket>();
    const active: ActiveBridge = {
      descriptor,
      server: createServer((client) => forward(client, active, sockets)),
      sockets,
      target,
    };
    try {
      await listen(active.server, target.localPort);
    } catch (error) {
      throw localListenError(error, target.localPort);
    }
    if (this.disposed) {
      await closeServer(active.server);
      throw new Error("Localhost bridges have been disposed.");
    }
    active.server.unref();
    this.bridges.set(target.localPort, active);
    return structuredClone(descriptor);
  }
}

function forward(client: Socket, bridge: ActiveBridge, sockets: Set<Socket>): void {
  const upstream = createConnection({
    host: bridge.target.remoteHost,
    port: bridge.target.remotePort,
  });
  sockets.add(client);
  sockets.add(upstream);
  const cleanup = (): void => {
    sockets.delete(client);
    sockets.delete(upstream);
  };
  client.once("close", cleanup);
  upstream.once("close", cleanup);
  client.once("error", () => upstream.destroy());
  upstream.once("error", () => client.destroy());
  client.pipe(upstream).pipe(client);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, LOOPBACK_ADDRESS, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function normalizeTarget(target: LocalhostBridgeTarget): LocalhostBridgeTarget {
  const remoteHost = target.remoteHost.trim();
  if (!remoteHost) throw new Error("The remote Device did not provide a Tailscale address.");
  return {
    deviceId: target.deviceId,
    deviceName: target.deviceName.trim() || target.deviceId,
    localPort: validPort(target.localPort),
    remoteHost,
    remotePort: validPort(target.remotePort),
  };
}

function validPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Port must be between 1 and 65535.");
  }
  return port;
}

function assertSameOwner(
  current: Pick<LocalhostBridge, "deviceId" | "deviceName">,
  requested: Pick<LocalhostBridgeTarget, "deviceId" | "deviceName" | "localPort">,
): void {
  if (current.deviceId === requested.deviceId) return;
  throw new Error(`localhost:${requested.localPort} is already mapped to ${current.deviceName}.`);
}

function localListenError(error: unknown, port: number): Error {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return new Error(`localhost:${port} is already in use on this Device.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
