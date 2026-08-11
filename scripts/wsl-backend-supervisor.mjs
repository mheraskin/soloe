import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const dataDirectory = required("SOLOE_DATA_DIR");
const ownerId = required("SOLOE_OWNER_ID");
const leasePath = required("SOLOE_TRAY_LEASE");
const runtimeEndpoint = required("SOLOE_RUNTIME_ENDPOINT");
const leaseTimeoutMs = Number(process.env.SOLOE_LEASE_TIMEOUT_MS ?? "6000");
const stopTimeoutMs = Number(process.env.SOLOE_STOP_TIMEOUT_MS ?? "5000");
const children = new Map();
let stopping = false;
let shutdownTask;
let serverRestartAttempts = 0;

writeRecord("supervisor", {
  service: "supervisor",
  pid: process.pid,
  ownerId,
  startedAt: new Date().toISOString(),
});

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
process.once("SIGHUP", () => requestShutdown("SIGHUP"));

try {
  await startService("@soloe/runtime", "runtime");
  await waitForRecord("runtime");
  if (serverIsDesired()) {
    await startService("@soloe/server", "server");
    await waitForRecord("server");
  }

  while (!stopping) {
    if (!leaseIsCurrent()) {
      requestShutdown("tray ownership lease expired");
      break;
    }
    if (childExited(children.get("runtime"))) {
      requestShutdown("runtime exited");
      break;
    }
    if (!serverIsDesired() && !childExited(children.get("server"))) {
      appendSupervisorLog("[wsl-supervisor] stopping server on tray request\n");
      await stopChild("server");
      serverRestartAttempts = 0;
      continue;
    }
    if (serverIsDesired() && childExited(children.get("server"))) {
      await restartServer();
      continue;
    }
    await delay(500);
  }
  await shutdownTask;
} catch (error) {
  appendSupervisorLog(
    `[wsl-supervisor] startup failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  requestShutdown("startup failure");
  await shutdownTask;
  process.exitCode = 1;
} finally {
  removeOwnRecord("supervisor");
  removeOwnRecord("supervisor-control");
}

async function startService(workspace, service) {
  const output = openSync(path.join(dataDirectory, `${service}.log`), "a");
  const child = spawn("pnpm", ["--filter", workspace, "start"], {
    detached: true,
    env: {
      ...process.env,
      SOLOE_DATA_DIR: dataDirectory,
      SOLOE_OWNER_ID: ownerId,
      SOLOE_RUNTIME_ENDPOINT: runtimeEndpoint,
      SOLOE_WEB_ROOT: "",
    },
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  children.set(service, child);
  child.once("error", (error) => {
    appendSupervisorLog(`[wsl-supervisor] ${service} spawn failed: ${error.message}\n`);
  });
}

async function waitForRecord(service) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const record = readRecord(service);
    if (record?.ownerId === ownerId && processIsAlive(record.pid)) return;
    const child = children.get(service);
    if (childExited(child)) {
      throw new Error(
        `${service} exited with ${child?.signalCode ?? `code ${child?.exitCode ?? "unknown"}`}`,
      );
    }
    await delay(100);
  }
  throw new Error(
    `${service} did not become ready; inspect ${path.join(dataDirectory, `${service}.log`)}`,
  );
}

async function restartServer() {
  serverRestartAttempts += 1;
  const backoffMs = Math.min(5_000, serverRestartAttempts * 500);
  const previous = children.get("server");
  appendSupervisorLog(
    `[wsl-supervisor] server process ${previous?.pid ?? "unknown"} exited; `
      + `restart attempt ${serverRestartAttempts} in ${backoffMs}ms\n`,
  );
  removeOwnRecord("server");
  await delay(backoffMs);
  if (stopping || !leaseIsCurrent() || !serverIsDesired()) return;
  await startService("@soloe/server", "server");
  try {
    await waitForRecord("server");
    appendSupervisorLog(
      `[wsl-supervisor] server restarted as process ${children.get("server")?.pid ?? "unknown"}\n`,
    );
    serverRestartAttempts = 0;
  } catch (error) {
    appendSupervisorLog(
      `[wsl-supervisor] server restart failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  appendSupervisorLog(`[wsl-supervisor] stopping managed backend: ${reason}\n`);
  await stopChild("server");
  await stopChild("runtime");
}

function requestShutdown(reason) {
  shutdownTask ??= shutdown(reason);
}

async function stopChild(service) {
  const child = children.get(service);
  if (childExited(child)) {
    removeOwnRecord(service);
    return;
  }
  signalGroup(child.pid, "SIGTERM");
  await waitForExit(child, stopTimeoutMs);
  if (groupIsAlive(child.pid)) {
    appendSupervisorLog(`[wsl-supervisor] forcing ${service} process group ${child.pid}\n`);
    signalGroup(child.pid, "SIGKILL");
    await waitForExit(child, 1000);
  }
  removeOwnRecord(service);
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      appendSupervisorLog(
        `[wsl-supervisor] ${signal} failed for process group ${pid}: ${error.message}\n`,
      );
    }
  }
}

function groupIsAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function leaseIsCurrent() {
  try {
    const lease = JSON.parse(readFileSync(leasePath, "utf8"));
    return lease.ownerId === ownerId && Date.now() - Number(lease.updatedAtMs) <= leaseTimeoutMs;
  } catch {
    return false;
  }
}

function serverIsDesired() {
  const control = readRecord("supervisor-control");
  return control?.ownerId !== ownerId || control.serverRunning !== false;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecord(service) {
  try {
    return JSON.parse(readFileSync(path.join(dataDirectory, `${service}.json`), "utf8"));
  } catch {
    return null;
  }
}

function writeRecord(service, record) {
  const destination = path.join(dataDirectory, `${service}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
}

function removeOwnRecord(service) {
  const record = readRecord(service);
  if (record?.ownerId === ownerId) {
    rmSync(path.join(dataDirectory, `${service}.json`), { force: true });
  }
}

function appendSupervisorLog(message) {
  const file = openSync(path.join(dataDirectory, "supervisor.log"), "a");
  try {
    writeFileSync(file, `${new Date().toISOString()} ${message}`);
  } finally {
    closeSync(file);
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
