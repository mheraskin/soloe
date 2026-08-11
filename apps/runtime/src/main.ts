import { mkdir } from "node:fs/promises";
import path from "node:path";
import { NodePtyRuntimeProcessFactory } from "./NodePtyRuntimeProcessFactory.js";
import {
  resolveRuntimeEndpoint,
  resolveSoloeDataDirectory,
} from "./RuntimeEndpoint.js";
import { RuntimeHost } from "./RuntimeHost.js";
import { removeServiceInfo, writeServiceInfo } from "./ServiceRendezvous.js";
import {
  prepareRuntimeEndpoint,
  secureRuntimeEndpoint,
} from "./RuntimeSocket.js";

const dataDirectory = resolveSoloeDataDirectory();
const ownerId = process.env.SOLOE_OWNER_ID;
const endpoint =
  process.env.SOLOE_RUNTIME_ENDPOINT ?? resolveRuntimeEndpoint({ dataDirectory });
if (process.platform !== "win32") {
  await mkdir(path.dirname(endpoint), { recursive: true });
}
await prepareRuntimeEndpoint(endpoint);

const runtime = new RuntimeHost({
  endpoint,
  processFactory: new NodePtyRuntimeProcessFactory(),
});
await runtime.listen();
await secureRuntimeEndpoint(endpoint);
await writeServiceInfo(dataDirectory, {
  service: "runtime",
  pid: process.pid,
  startedAt: new Date().toISOString(),
  ...(ownerId ? { ownerId } : {}),
  endpoint,
});
process.stdout.write(`${JSON.stringify({ service: "runtime", endpoint, ready: true })}\n`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime.shutdown();
  await removeServiceInfo(dataDirectory, "runtime", process.pid, ownerId);
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
