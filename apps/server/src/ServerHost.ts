import {
  RuntimeClient,
  loadOrCreateServerToken,
  removeServiceInfo,
  resolveRuntimeEndpoint,
  resolveSoloeDataDirectory,
  writeServiceInfo,
} from "@soloe/runtime";

import { SoloeDomain } from "./SoloeDomain.js";
import { SoloeServer } from "./SoloeServer.js";

export interface RunningServerHost {
  address: string;
  close(): Promise<void>;
}

export async function startServerHost(): Promise<RunningServerHost> {
  const dataDirectory = resolveSoloeDataDirectory();
  const ownerId = process.env.SOLOE_OWNER_ID;
  const token =
    process.env.SOLOE_SERVER_TOKEN ??
    (await loadOrCreateServerToken(dataDirectory));
  const runtimeEndpoint =
    process.env.SOLOE_RUNTIME_ENDPOINT ??
    resolveRuntimeEndpoint({ dataDirectory });
  const domainRuntime = await RuntimeClient.connect(runtimeEndpoint);
  const domain = new SoloeDomain({
    dataDirectory,
    runtime: domainRuntime,
    enableAgentBridge: true,
  });
  const server = new SoloeServer({
    runtimeEndpoint,
    host: process.env.SOLOE_SERVER_HOST ?? "127.0.0.1",
    port: Number(process.env.SOLOE_SERVER_PORT ?? "4317"),
    token,
    webRoot: process.env.SOLOE_WEB_ROOT ?? "",
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
    });
    process.stdout.write(
      `${JSON.stringify({ service: "server", address, ready: true })}\n`,
    );

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
