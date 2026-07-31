import { spawn } from "node:child_process";
import type {
  RuntimeProcessUsageComponent,
  RuntimeUsageSnapshot,
} from "@soloe/protocol";

export interface ProcessUsageRow {
  pid: number;
  parentPid: number;
  memoryKb: number;
  cpuPercent: number;
}

export interface ProcessTreeUsageSamplerOptions {
  rootPid?: number;
  platform?: NodeJS.Platform;
  listRows?: () => Promise<ProcessUsageRow[]>;
  now?: () => Date;
}

const PROCESS_LIST_TIMEOUT_MS = 1_500;
const PROCESS_LIST_MAX_BYTES = 8 * 1024 * 1024;

export class ProcessTreeUsageSampler {
  private readonly rootPid: number;
  private readonly platform: NodeJS.Platform;
  private readonly listRows: () => Promise<ProcessUsageRow[]>;
  private readonly now: () => Date;
  private inFlight: Promise<RuntimeUsageSnapshot> | null = null;

  constructor(options: ProcessTreeUsageSamplerOptions = {}) {
    this.rootPid = options.rootPid ?? process.pid;
    this.platform = options.platform ?? process.platform;
    this.listRows = options.listRows ?? listUnixProcessRows;
    this.now = options.now ?? (() => new Date());
  }

  sample(): Promise<RuntimeUsageSnapshot> {
    if (this.inFlight) return this.inFlight;
    const request = this.collect().finally(() => {
      if (this.inFlight === request) this.inFlight = null;
    });
    this.inFlight = request;
    return request;
  }

  private async collect(): Promise<RuntimeUsageSnapshot> {
    const sampledAt = this.now().toISOString();
    if (this.platform === "win32") {
      return unavailableSnapshot(
        sampledAt,
        "process tree sampling is not available on this platform",
      );
    }

    let rows: ProcessUsageRow[];
    try {
      rows = await this.listRows();
    } catch (error) {
      return unavailableSnapshot(
        sampledAt,
        error instanceof Error ? error.message : "process list unavailable",
      );
    }

    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const root = byPid.get(this.rootPid);
    if (!root) {
      return unavailableSnapshot(
        sampledAt,
        `process ${this.rootPid} was absent from the process list`,
      );
    }

    const selected = collectDescendantPids(rows, this.rootPid);
    const childRows = [...selected]
      .filter((pid) => pid !== this.rootPid)
      .map((pid) => byPid.get(pid))
      .filter((row): row is ProcessUsageRow => row !== undefined);
    const rootComponent = component("runtime", [root]);
    const childComponent = component("agent-pty", childRows);
    const allRows = [root, ...childRows];

    return {
      availability: "available",
      cpuPercent: round(
        allRows.reduce((total, row) => total + row.cpuPercent, 0),
        1,
      ),
      memoryBytes: allRows.reduce(
        (total, row) => total + row.memoryKb * 1024,
        0,
      ),
      processCount: allRows.length,
      components: [rootComponent, childComponent],
      sampledAt,
    };
  }
}

export function parseProcessUsageRows(output: string): ProcessUsageRow[] {
  const rows: ProcessUsageRow[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 4) continue;
    const [pidText, parentPidText, memoryText, cpuText] = fields;
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    const memoryKb = Number(memoryText);
    const cpuPercent = Number(cpuText);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isFinite(memoryKb) ||
      memoryKb < 0 ||
      !Number.isFinite(cpuPercent) ||
      cpuPercent < 0
    ) {
      continue;
    }
    rows.push({ pid, parentPid, memoryKb, cpuPercent });
  }
  return rows;
}

function collectDescendantPids(
  rows: ProcessUsageRow[],
  rootPid: number,
): Set<number> {
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.pid) || !selected.has(row.parentPid)) continue;
      selected.add(row.pid);
      changed = true;
    }
  }
  return selected;
}

function component(
  kind: RuntimeProcessUsageComponent["kind"],
  rows: ProcessUsageRow[],
): RuntimeProcessUsageComponent {
  return {
    kind,
    availability: "available",
    cpuPercent: round(
      rows.reduce((total, row) => total + row.cpuPercent, 0),
      1,
    ),
    memoryBytes: rows.reduce(
      (total, row) => total + row.memoryKb * 1024,
      0,
    ),
    processCount: rows.length,
  };
}

function unavailableSnapshot(
  sampledAt: string,
  message: string,
): RuntimeUsageSnapshot {
  return {
    availability: "unavailable",
    cpuPercent: null,
    memoryBytes: null,
    processCount: null,
    components: [
      {
        kind: "runtime",
        availability: "unavailable",
        cpuPercent: null,
        memoryBytes: null,
        processCount: null,
        message,
      },
      {
        kind: "agent-pty",
        availability: "unavailable",
        cpuPercent: null,
        memoryBytes: null,
        processCount: null,
        message: "runtime process tree unavailable",
      },
    ],
    sampledAt,
    message,
  };
}

async function listUnixProcessRows(): Promise<ProcessUsageRow[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("ps", ["-axo", "pid=,ppid=,rss=,pcpu="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    let stdout = "";
    let bytes = 0;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("process list timed out")));
    }, PROCESS_LIST_TIMEOUT_MS);

    child.stdout.on("data", (buffer: Buffer) => {
      bytes += buffer.byteLength;
      if (bytes > PROCESS_LIST_MAX_BYTES) {
        child.kill();
        finish(() => reject(new Error("process list exceeded the size limit")));
        return;
      }
      stdout += buffer.toString("utf8");
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`process list exited with code ${code ?? "unknown"}`));
          return;
        }
        resolve(
          parseProcessUsageRows(stdout).filter((row) => row.pid !== child.pid),
        );
      });
    });
  });
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
