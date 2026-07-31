import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type {
  CrashLogSummary,
  DiagnosticItem,
  DiagnosticLogsRequest,
  DiagnosticSeverity,
} from "../../../../shared/types/diagnostics.js";
import type { SettingsBinaries } from "../../../../shared/types/settings.js";

interface DiagnosticsSettings {
  binaries: SettingsBinaries;
}

interface DiagnosticsProject {
  id: string;
  name: string;
  path: string;
}

interface DirtySummary {
  isRepo: boolean;
  dirty?: boolean;
  staged?: number;
  unstaged?: number;
  untracked?: number;
}

export interface DiagnosticsServiceOptions {
  settings: { get(): Promise<DiagnosticsSettings> | DiagnosticsSettings };
  projects: {
    list(): Promise<DiagnosticsProject[]> | DiagnosticsProject[];
  };
  git: {
    getDirty(cwd: string): Promise<DirtySummary>;
  };
  crashDir: string;
  logDirectory?: string;
  maxLogs?: number;
}

interface LogCandidate {
  fileName: string;
  fullPath: string;
  service: CrashLogSummary["service"];
  severity: DiagnosticSeverity;
}

const DEFAULT_TAIL_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_LOGS = 50;
const SERVICE_LOGS = new Map<string, CrashLogSummary["service"]>([
  ["tray.log", "tray"],
  ["server.log", "server"],
  ["runtime.log", "runtime"],
  ["web.log", "web"],
  ["supervisor.log", "supervisor"],
]);

export class DiagnosticsService {
  private readonly logDirectory: string;
  private readonly maxLogs: number;

  constructor(private readonly options: DiagnosticsServiceOptions) {
    this.logDirectory =
      options.logDirectory ?? path.dirname(options.crashDir);
    this.maxLogs = positiveInteger(options.maxLogs, DEFAULT_MAX_LOGS);
  }

  async list(): Promise<DiagnosticItem[]> {
    const [binaryIssues, projectIssues, logs] = await Promise.all([
      this.binaryDiagnostics(),
      this.projectDiagnostics(),
      this.crashLogs({ tailBytes: 0 }),
    ]);
    const crashes = logs.filter((log) => log.service === "crash");
    const crashIssue: DiagnosticItem[] =
      crashes.length > 0
        ? [
            {
              id: "crashes.recent",
              severity: "warn",
              message: `${crashes.length} crash log${crashes.length === 1 ? "" : "s"} available`,
              detail: crashes[0]?.fileName,
              action: "project",
            },
          ]
        : [];
    return [...binaryIssues, ...projectIssues, ...crashIssue];
  }

  async crashLogs(
    request: DiagnosticLogsRequest = {},
  ): Promise<CrashLogSummary[]> {
    const tailBytes = boundedTailBytes(request.tailBytes);
    const candidates = await this.logCandidates();
    const logs = await Promise.all(
      candidates.map((candidate) => this.readLog(candidate, tailBytes)),
    );
    return logs
      .filter((log): log is CrashLogSummary => log !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, this.maxLogs);
  }

  private async logCandidates(): Promise<LogCandidate[]> {
    const candidates: LogCandidate[] = [];
    for (const [fileName, service] of SERVICE_LOGS) {
      candidates.push({
        fileName,
        fullPath: path.join(this.logDirectory, fileName),
        service,
        severity: service === "supervisor" ? "warn" : "info",
      });
    }
    let entries: string[];
    try {
      entries = await fs.readdir(this.options.crashDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidates;
      throw error;
    }
    for (const fileName of entries.sort().reverse().slice(0, this.maxLogs)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}\.log$/u.test(fileName)
      ) {
        continue;
      }
      candidates.push({
        fileName,
        fullPath: path.join(this.options.crashDir, fileName),
        service: "crash",
        severity: "error",
      });
    }
    return candidates;
  }

  private async readLog(
    candidate: LogCandidate,
    tailBytes: number,
  ): Promise<CrashLogSummary | null> {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      const info = await fs.lstat(candidate.fullPath);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const canonicalRoot = await fs.realpath(
        candidate.service === "crash"
          ? this.options.crashDir
          : this.logDirectory,
      );
      const canonicalFile = await fs.realpath(candidate.fullPath);
      if (!isWithin(canonicalRoot, canonicalFile)) return null;
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      handle = await fs.open(
        canonicalFile,
        constants.O_RDONLY | noFollow,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const length = Math.min(tailBytes, stat.size);
      let tail = "";
      if (length > 0) {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          length,
          stat.size - length,
        );
        tail = redactSensitive(buffer.subarray(0, bytesRead).toString("utf8"));
      }
      return {
        fileName: candidate.fileName,
        service: candidate.service,
        severity: candidate.severity,
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        tail,
        truncated: stat.size > length,
      };
    } catch (error) {
      if (
        ["ENOENT", "ELOOP", "EINVAL"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        return null;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async binaryDiagnostics(): Promise<DiagnosticItem[]> {
    const settings = await this.options.settings.get();
    const output: DiagnosticItem[] = [];
    for (const [name, configuredPath] of Object.entries(settings.binaries)) {
      if (!configuredPath) continue;
      try {
        await fs.access(configuredPath);
      } catch {
        output.push({
          id: `binary.${name}`,
          severity: "error",
          message: `Configured ${name} binary is missing`,
          detail: configuredPath,
          action: "settings",
        });
      }
    }
    return output;
  }

  private async projectDiagnostics(): Promise<DiagnosticItem[]> {
    const projects = await this.options.projects.list();
    const output: DiagnosticItem[] = [];
    for (const project of projects) {
      const dirty = await this.options.git.getDirty(project.path);
      if (!dirty.isRepo || !dirty.dirty) continue;
      output.push({
        id: `project.${project.id}.dirty`,
        severity: "warn",
        message: `${project.name} has uncommitted changes`,
        detail: `${dirty.staged ?? 0} staged, ${dirty.unstaged ?? 0} unstaged, ${dirty.untracked ?? 0} untracked`,
        action: "project",
      });
    }
    return output;
  }
}

export function redactSensitive(value: string): string {
  return value
    .replace(
      /\b(Bearer)\s+[^\s"'`,;]+/giu,
      "$1 [REDACTED]",
    )
    .replace(
      /(["']?[a-z0-9_.-]*(?:token|secret|password|passwd|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key|credential)[a-z0-9_.-]*["']?\s*[:=]\s*)(["']?)[^"',\s}]+(\2)/giu,
      "$1$2[REDACTED]$3",
    )
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|AUTHORIZATION))=([^\s]+)/gu,
      "$1=[REDACTED]",
    )
    .replace(
      /([?&](?:token|secret|password|api[_-]?key)=)[^&#\s]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s/]+(@)/giu,
      "$1[REDACTED]$2",
    );
}

function boundedTailBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TAIL_BYTES;
  if (!Number.isInteger(value) || value < 0 || value > MAX_TAIL_BYTES) {
    throw new Error(`tailBytes must be an integer from 0 to ${MAX_TAIL_BYTES}`);
  }
  return value;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}
