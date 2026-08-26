import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/**
 * Standard HTTPS keeps the Soloe tailnet URL clean (`https://device.ts.net/`)
 * while Tailscale proxies to Soloe's loopback web host internally.
 */
export const DEFAULT_TAILSCALE_HTTPS_PORT = 443;
/** The pre-443 default, retained only for persisted-settings migration. */
export const LEGACY_TAILSCALE_HTTPS_PORT = 4318;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type TailscaleServeState =
  | "ready"
  | "unavailable"
  | "not-running"
  | "setup-required"
  | "conflict"
  | "error";

export interface TailscaleServeStatus {
  state: TailscaleServeState;
  message: string | null;
  setupUrl: string | null;
}

export type TailscaleCommandRunner = (
  args: readonly string[],
) => Promise<string>;

export interface TailscaleServeManagerOptions {
  targetUrl: string;
  httpsPort?: number;
  run?: TailscaleCommandRunner;
}

export interface TailscalePortForwardStatus extends TailscaleServeStatus {
  dnsName: string | null;
  ipAddress: string | null;
  port: number;
  forwarded: boolean;
}

export type TailscalePortProbe = (
  host: string,
  port: number,
) => Promise<boolean>;

export interface TailscalePortForwardManagerOptions {
  run?: TailscaleCommandRunner;
  probe?: TailscalePortProbe;
}

/**
 * Publishes one loopback TCP listener on the Device's Tailscale address.
 * A direct listener satisfies the request only when it is also the requested
 * target. Unrelated Serve routes are never replaced.
 */
export class TailscalePortForwardManager {
  private readonly run: TailscaleCommandRunner;
  private readonly probe: TailscalePortProbe;

  constructor(options: TailscalePortForwardManagerOptions = {}) {
    this.run = options.run ?? runTailscaleCommand;
    this.probe = options.probe ?? probeTcpPort;
  }

  async ensure(
    rawPort: number,
    rawTargetPort: number = rawPort,
  ): Promise<TailscalePortForwardStatus> {
    const port = validPort(rawPort);
    const targetPort = validPort(rawTargetPort);
    let selfDnsName: string;
    let selfIpAddress: string | null;
    let serveStatus: unknown;
    try {
      const status = parseJsonStatus(await this.run(["status", "--json"]), "status");
      selfDnsName = parseSelfDnsName(status);
      selfIpAddress = parseSelfIpv4Address(status);
      serveStatus = parseJsonStatus(
        await this.run(["serve", "status", "--json"]),
        "Serve status",
      );
    } catch (error) {
      return portForwardFailure(commandFailure(error), port);
    }

    const existing = inspectTcpForward(serveStatus, port, targetPort);
    if (existing === "owned") {
      return readyPortForward(selfDnsName, selfIpAddress, port, true);
    }
    if (existing === "occupied") {
      return {
        state: "conflict",
        message: `Tailscale Serve port ${port} is already used by another service.`,
        setupUrl: null,
        dnsName: selfDnsName,
        ipAddress: selfIpAddress,
        port,
        forwarded: false,
      };
    }

    if (
      existing === "free"
      && targetPort === port
      && await this.probe(selfDnsName, port)
    ) {
      return readyPortForward(selfDnsName, selfIpAddress, port, false);
    }

    const loopbackHost = await firstListeningLoopback(this.probe, targetPort);
    if (!loopbackHost) {
      return {
        state: "error",
        message: `Nothing is listening on localhost:${targetPort} on this Device.`,
        setupUrl: null,
        dnsName: selfDnsName,
        ipAddress: selfIpAddress,
        port,
        forwarded: false,
      };
    }

    const target = loopbackHost === "::1"
      ? `tcp://[::1]:${targetPort}`
      : `tcp://127.0.0.1:${targetPort}`;
    try {
      await this.run([
        "serve",
        "--bg",
        "--yes",
        `--tcp=${port}`,
        target,
      ]);
      return readyPortForward(selfDnsName, selfIpAddress, port, true);
    } catch (error) {
      return portForwardFailure(commandFailure(error), port, selfDnsName, selfIpAddress);
    }
  }
}

/**
 * Owns only Soloe's dedicated Tailscale Serve listener. It never resets Serve
 * or overwrites another route on the machine.
 */
export class TailscaleServeManager {
  private readonly targetUrl: string;
  private readonly httpsPort: number;
  private readonly run: TailscaleCommandRunner;

  constructor(options: TailscaleServeManagerOptions) {
    this.targetUrl = normalizeLoopbackTarget(options.targetUrl);
    this.httpsPort = validPort(options.httpsPort ?? DEFAULT_TAILSCALE_HTTPS_PORT);
    this.run = options.run ?? runTailscaleCommand;
  }

  async ensure(): Promise<TailscaleServeStatus> {
    let selfDnsName: string;
    let serveStatus: unknown;
    try {
      selfDnsName = parseSelfDnsName(
        parseJsonStatus(await this.run(["status", "--json"]), "status"),
      );
      serveStatus = parseJsonStatus(
        await this.run(["serve", "status", "--json"]),
        "Serve status",
      );
    } catch (error) {
      return commandFailure(error);
    }

    const route = inspectPort(
      serveStatus,
      selfDnsName,
      this.httpsPort,
      this.targetUrl,
    );
    if (route === "owned") return ready();
    if (route === "occupied") {
      return {
        state: "conflict",
        message: `Tailscale Serve port ${this.httpsPort} is already used by another service.`,
        setupUrl: null,
      };
    }

    try {
      await this.run([
        "serve",
        "--bg",
        "--yes",
        `--https=${this.httpsPort}`,
        this.targetUrl,
      ]);
      return ready();
    } catch (error) {
      return commandFailure(error);
    }
  }
}

export async function runTailscaleCommand(args: readonly string[]): Promise<string> {
  let missing: unknown = null;
  for (const executable of tailscaleExecutableCandidates(process.platform, process.env)) {
    try {
      const { stdout } = await execFileAsync(executable, [...args], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = error;
    }
  }
  throw missing ?? Object.assign(new Error("Tailscale CLI was not found."), { code: "ENOENT" });
}

export function tailscaleExecutableCandidates(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const override = environment.SOLOE_TAILSCALE_CLI?.trim();
  if (override) return [override];
  const candidates: string[] = [];
  if (platform === "darwin") {
    candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    const home = environment.HOME?.trim();
    if (home) candidates.push(`${home.replace(/\/$/u, "")}/Applications/Tailscale.app/Contents/MacOS/Tailscale`);
  } else if (platform === "win32") {
    const programFiles = environment.ProgramFiles?.trim()
      || environment.ProgramW6432?.trim()
      || "C:\\Program Files";
    candidates.push(`${programFiles.replace(/[\\/]$/u, "")}\\Tailscale\\tailscale.exe`);
    const localAppData = environment.LOCALAPPDATA?.trim();
    if (localAppData) {
      candidates.push(`${localAppData.replace(/[\\/]$/u, "")}\\Tailscale\\tailscale.exe`);
    }
  }
  candidates.push("tailscale");
  return [...new Set(candidates)];
}

function inspectPort(
  raw: unknown,
  selfDnsName: string,
  httpsPort: number,
  targetUrl: string,
): "free" | "owned" | "occupied" {
  if (!isRecord(raw)) return "free";
  const port = String(httpsPort);
  const tcp = isRecord(raw.TCP) ? raw.TCP : {};
  const web = isRecord(raw.Web) ? raw.Web : {};
  const expectedAuthority = `${selfDnsName}:${port}`;
  let currentWebEntry: Record<string, unknown> | null = null;

  for (const [authority, value] of Object.entries(web)) {
    if (authority.toLowerCase() !== expectedAuthority || !isRecord(value)) continue;
    currentWebEntry = value;
    break;
  }

  const tcpEntry = tcp[port];
  const httpsEnabled = isRecord(tcpEntry) && tcpEntry.HTTPS === true;
  if (currentWebEntry) {
    const handlers = isRecord(currentWebEntry.Handlers)
      ? currentWebEntry.Handlers
      : {};
    const root = isRecord(handlers["/"]) ? handlers["/"] : null;
    if (httpsEnabled && root && normalizeComparableUrl(root.Proxy) === targetUrl) {
      return "owned";
    }
    return "occupied";
  }

  // Tailscale keys Web routes by the device DNS name. After a device rename,
  // TCP can still contain the HTTPS listener while Web only contains obsolete
  // authorities. Re-declaring our dedicated port creates the current route.
  if (tcpEntry === undefined || httpsEnabled) return "free";
  return "occupied";
}

function inspectTcpForward(
  raw: unknown,
  port: number,
  targetPort: number,
): "free" | "owned" | "stale-owned" | "occupied" {
  if (!isRecord(raw) || !isRecord(raw.TCP)) return "free";
  const handler = raw.TCP[String(port)];
  if (!isRecord(handler)) return "free";
  const target = typeof handler.TCPForward === "string"
    ? normalizeTcpTarget(handler.TCPForward)
    : null;
  if (target === `127.0.0.1:${targetPort}` || target === `[::1]:${targetPort}`) {
    return "owned";
  }
  // Previous Soloe versions published the same loopback and public port. It
  // is safe to migrate that route to the private browser proxy listener.
  if (
    targetPort !== port
    && (target === `127.0.0.1:${port}` || target === `[::1]:${port}`)
  ) return "stale-owned";
  return "occupied";
}

function normalizeTcpTarget(value: string): string {
  const trimmed = value.trim().replace(/^tcp:\/\//u, "");
  if (trimmed.startsWith("localhost:")) {
    return `127.0.0.1:${trimmed.slice("localhost:".length)}`;
  }
  return trimmed;
}

async function firstListeningLoopback(
  probe: TailscalePortProbe,
  port: number,
): Promise<"127.0.0.1" | "::1" | null> {
  if (await probe("127.0.0.1", port)) return "127.0.0.1";
  if (await probe("::1", port)) return "::1";
  return null;
}

function readyPortForward(
  dnsName: string,
  ipAddress: string | null,
  port: number,
  forwarded: boolean,
): TailscalePortForwardStatus {
  return {
    state: "ready",
    message: null,
    setupUrl: null,
    dnsName,
    ipAddress,
    port,
    forwarded,
  };
}

function portForwardFailure(
  status: TailscaleServeStatus,
  port: number,
  dnsName: string | null = null,
  ipAddress: string | null = null,
): TailscalePortForwardStatus {
  return { ...status, dnsName, ipAddress, port, forwarded: false };
}

function probeTcpPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function parseJsonStatus(raw: string, label: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid Tailscale ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseSelfDnsName(raw: unknown): string {
  const self = isRecord(raw) && isRecord(raw.Self) ? raw.Self : null;
  const dnsName = self && typeof self.DNSName === "string"
    ? self.DNSName.trim().replace(/\.+$/u, "").toLowerCase()
    : "";
  if (!dnsName) {
    throw new Error("Tailscale status did not report this device's DNS name.");
  }
  return dnsName;
}

function parseSelfIpv4Address(raw: unknown): string | null {
  const self = isRecord(raw) && isRecord(raw.Self) ? raw.Self : null;
  const addresses = self && Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  return addresses.find((value): value is string =>
    typeof value === "string" && isIpv4Address(value)
  ) ?? null;
}

function isIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/u.test(octet)) return false;
    if (octet.length > 1 && octet.startsWith("0")) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
}

function commandFailure(error: unknown): TailscaleServeStatus {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      state: "unavailable",
      message: "Install Tailscale to connect this Soloe Device to other machines.",
      setupUrl: "https://tailscale.com/download",
    };
  }
  const detail = error instanceof Error ? error.message : String(error);
  const setupUrl = extractConsentUrl(detail);
  if (setupUrl) {
    return {
      state: "setup-required",
      message: "Tailscale needs one-time approval before Soloe can connect devices.",
      setupUrl,
    };
  }
  if (/needslogin|not logged in|not running|backend.*stopped/iu.test(detail)) {
    return {
      state: "not-running",
      message: "Open Tailscale and sign in to connect Soloe Devices.",
      setupUrl: null,
    };
  }
  return {
    state: "error",
    message: detail,
    setupUrl: null,
  };
}

function extractConsentUrl(detail: string): string | null {
  const match = detail.match(/https:\/\/login\.tailscale\.com\/[^\s)]+/iu);
  return match?.[0].replace(/[.,;:]$/u, "") ?? null;
}

function normalizeLoopbackTarget(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Tailscale Serve target must be a loopback HTTP URL.");
  }
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Tailscale Serve target must be a loopback HTTP URL.");
  }
  return url.origin;
}

function normalizeComparableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function validPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Tailscale Serve HTTPS port must be a valid TCP port.");
  }
  return value;
}

function ready(): TailscaleServeStatus {
  return { state: "ready", message: null, setupUrl: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
