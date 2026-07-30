import {
  resolveRuntimeEndpoint,
  resolveSoloeDataDirectory,
  removeServiceInfo,
  loadOrCreateServerToken,
  writeServiceInfo,
  RuntimeClient,
} from "@soloe/runtime";
import { SoloeServer } from "./SoloeServer.js";
import { SoloeDomain } from "./SoloeDomain.js";

const dataDirectory = resolveSoloeDataDirectory();
const ownerId = process.env.SOLOE_OWNER_ID;
const token =
  process.env.SOLOE_SERVER_TOKEN ?? (await loadOrCreateServerToken(dataDirectory));
const runtimeEndpoint =
  process.env.SOLOE_RUNTIME_ENDPOINT ?? resolveRuntimeEndpoint({ dataDirectory });
const domainRuntime = await RuntimeClient.connect(runtimeEndpoint);
const domain = new SoloeDomain({ dataDirectory, runtime: domainRuntime });
await domain.init();
const server = new SoloeServer({
  runtimeEndpoint,
  host: process.env.SOLOE_SERVER_HOST ?? "127.0.0.1",
  port: Number(process.env.SOLOE_SERVER_PORT ?? "4317"),
  token,
  webRoot: process.env.SOLOE_WEB_ROOT ?? "",
  rpcHandler: (call) => domain.invoke(call),
});
domain.on("event", (event, payload) => server.publish(event, payload));
const address = await server.listen();
await writeServiceInfo(dataDirectory, {
  service: "server",
  pid: process.pid,
  startedAt: new Date().toISOString(),
  ...(ownerId ? { ownerId } : {}),
  address,
  token,
});
process.stdout.write(`${JSON.stringify({ service: "server", address, ready: true })}\n`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close();
  domainRuntime.disconnect();
  await removeServiceInfo(dataDirectory, "server", process.pid, ownerId);
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
