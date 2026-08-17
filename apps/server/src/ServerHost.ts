import {
  DEFAULT_TAILSCALE_HTTPS_PORT,
  TailscaleServeManager,
} from "@soloe/domain";
import {
  RuntimeClient,
  loadOrCreateServerToken,
  removeServiceInfo,
  resolveRuntimeEndpoint,
  resolveSoloeDataDirectory,
  writeServiceInfo,
} from "@soloe/runtime";

import { SoloeDomain } from "./SoloeDomain.js";
import { DeviceDescriptorService } from "./DeviceDescriptorService.js";
import { DeviceIdentityStore } from "./DeviceIdentityStore.js";
import { SoloeServer } from "./SoloeServer.js";

export interface RunningServerHost {
  address: string;
  close(): Promise<void>;
}

export async function startServerHost(): Promise<RunningServerHost> {
  const dataDirectory = resolveSoloeDataDirectory();
  const identity = await new DeviceIdentityStore(dataDirectory).loadOrCreate();
  const descriptor = new DeviceDescriptorService({
    deviceId: identity.deviceId,
    serviceVersion: process.env.npm_package_version ?? "0.1.0",
  }).describe();
  const ownerId = process.env.SOLOE_OWNER_ID;
  const token =
    process.env.SOLOE_SERVER_TOKEN ??
    (await loadOrCreateServerToken(dataDirectory));
  const runtimeEndpoint =
    process.env.SOLOE_RUNTIME_ENDPOINT ??
    resolveRuntimeEndpoint({ dataDirectory });
  const webRoot = process.env.SOLOE_WEB_ROOT ?? "";
  const domainRuntime = await RuntimeClient.connect(runtimeEndpoint);
  const domain = new SoloeDomain({
    dataDirectory,
    deviceId: identity.deviceId,
    runtime: domainRuntime,
    enableAgentBridge: true,
  });
  const server = new SoloeServer({
    runtimeEndpoint,
    host: process.env.SOLOE_SERVER_HOST ?? "127.0.0.1",
    port: Number(process.env.SOLOE_SERVER_PORT ?? "4317"),
    token,
    deviceDescriptor: descriptor,
    webRoot,
    ...(process.env.SOLOE_TAILSCALE_ALLOWED_USERS !== undefined
      ? { allowedTailscaleUsers: process.env.SOLOE_TAILSCALE_ALLOWED_USERS }
      : {}),
    rpcHandler: (call) => domain.invoke(call),
    clientDisconnected: (clientId) => domain.releaseClient(clientId),
    clientReconnected: (clientId) => domain.recoverClient(clientId),
  });

  try {
    await domain.init();
    domain.on("event", (event, payload) => server.publish(event, payload));
    domain.on("targeted-event", (clientId, event, payload) =>
      server.publishToClient(clientId, event, payload),
    );
    const address = await server.listen();
    await writeServiceInfo(dataDirectory, {
      service: "server",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...(ownerId ? { ownerId } : {}),
      address,
      token,
      deviceId: identity.deviceId,
    });
    process.stdout.write(
      `${JSON.stringify({
        service: "server",
        address,
        deviceId: identity.deviceId,
        serverEpoch: descriptor.serverEpoch,
        ready: true,
      })}\n`,
    );
    if (shouldEnsureTailscaleSharing(process.env)) {
      void ensureTailscaleSharing(tailscaleServeTarget(address, process.env));
    }

    let closed = false;
    return {
      address,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await server.close();
        await domain.dispose();
        domainRuntime.disconnect();
        await removeServiceInfo(
          dataDirectory,
          "server",
          process.pid,
          ownerId,
        );
      },
    };
  } catch (error) {
    await server.close().catch(() => undefined);
    await domain.dispose().catch(() => undefined);
    domainRuntime.disconnect();
    throw error;
  }
}

export function shouldEnsureTailscaleSharing(
  environment: NodeJS.ProcessEnv,
): boolean {
  return environment.SOLOE_TAILSCALE_AUTO_SERVE !== "0";
}

/**
 * Development runs the browser host separately from the API server. Point
 * Tailscale at that host so the standard HTTPS endpoint serves the UI and the
 * Vite proxy can forward `/api` and WebSocket traffic to the server. Packaged
 * builds serve the UI from the API server's bundled web root instead.
 */
export function tailscaleServeTarget(
  serverAddress: string,
  environment: NodeJS.ProcessEnv,
): string {
  if (environment.SOLOE_WEB_ROOT?.trim()) return serverAddress;
  const webPort = environmentPort(environment.SOLOE_WEB_PORT, 4318);
  return `http://127.0.0.1:${webPort}`;
}

async function ensureTailscaleSharing(targetUrl: string): Promise<void> {
  const result = await new TailscaleServeManager({
    targetUrl,
    httpsPort: environmentPort(
      process.env.SOLOE_TAILSCALE_SERVE_PORT,
      DEFAULT_TAILSCALE_HTTPS_PORT,
    ),
  }).ensure();
  if (result.state === "ready") {
    process.stdout.write("[server] Soloe Device sharing is ready on Tailscale\n");
  } else if (result.state !== "unavailable" && result.state !== "not-running") {
    process.stderr.write(`[server] Tailscale sharing: ${result.message ?? result.state}\n`);
  }
}

function environmentPort(raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : fallback;
}
