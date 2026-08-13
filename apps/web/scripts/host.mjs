import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build, createServer, preview } from "vite";
import { TailscaleServeManager } from "@soloe/domain";

const mode = process.argv.includes("--preview") ? "preview" : "dev";
const dataDirectory = required("SOLOE_DATA_DIR");
const ownerId = required("SOLOE_OWNER_ID");
required("SOLOE_SERVER_URL");
const token = required("SOLOE_SERVER_TOKEN");

if (mode === "preview") {
  try {
    await access(path.resolve("../../out/web/index.html"));
  } catch {
    process.stdout.write("[web-host] browser assets missing; building the PWA\n");
    await build({ configFile: "vite.config.ts" });
  }
}

const host =
  mode === "dev"
    ? await createServer({ configFile: "vite.config.ts" })
    : await preview({ configFile: "vite.config.ts" });
if (mode === "dev") await host.listen();
host.printUrls();

const address = resolveAddress(host);
await writeServiceRecord({
  service: "web",
  pid: process.pid,
  ownerId,
  startedAt: new Date().toISOString(),
  address,
  token,
});
process.stdout.write(`${JSON.stringify({ service: "web", address, ready: true })}\n`);
if (process.env.SOLOE_TAILSCALE_AUTO_SERVE !== "0") {
  void ensureTailscaleSharing(address);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await host.close();
  await removeOwnServiceRecord();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("SIGHUP", () => void shutdown());

function resolveAddress(server) {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Windows web host did not bind to a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function writeServiceRecord(record) {
  await mkdir(dataDirectory, { recursive: true });
  const destination = path.join(dataDirectory, "web.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

async function removeOwnServiceRecord() {
  const destination = path.join(dataDirectory, "web.json");
  try {
    const current = JSON.parse(await readFile(destination, "utf8"));
    if (current.pid === process.pid && current.ownerId === ownerId) {
      await rm(destination, { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function ensureTailscaleSharing(targetUrl) {
  const result = await new TailscaleServeManager({
    targetUrl,
    httpsPort: environmentPort(process.env.SOLOE_TAILSCALE_SERVE_PORT, 4318),
  }).ensure();
  if (result.state === "ready") {
    process.stdout.write("[web-host] Soloe Device sharing is ready on Tailscale\n");
  } else if (result.state !== "unavailable" && result.state !== "not-running") {
    process.stderr.write(`[web-host] Tailscale sharing: ${result.message ?? result.state}\n`);
  }
}

function environmentPort(raw, fallback) {
  const value = raw?.trim() ? Number(raw) : fallback;
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : fallback;
}
