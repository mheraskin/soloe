import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowserRouteRequest } from "./BrowserRouteProxy.js";

interface BrowserRouteStorage {
  version: 1;
  routes: BrowserRouteRequest[];
}

const STORAGE_VERSION = 1;
const MAX_ROUTES = 64;

export class BrowserRouteStore {
  private routes: BrowserRouteRequest[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.routes) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.routes = await this.loadFromDisk();
  }

  async list(): Promise<BrowserRouteRequest[]> {
    await this.init();
    return this.routes!.map((route) => ({ ...route }));
  }

  async remember(request: BrowserRouteRequest): Promise<void> {
    await this.init();
    const route = sanitizeRoute(request);
    if (!route) throw new Error("Browser route is invalid");
    this.routes = [
      ...this.routes!.filter((saved) => saved.targetPort !== route.targetPort),
      route,
    ].slice(-MAX_ROUTES);
    await this.persist();
  }

  private async loadFromDisk(): Promise<BrowserRouteRequest[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const value = JSON.parse(raw) as Partial<BrowserRouteStorage>;
      if (value.version !== STORAGE_VERSION || !Array.isArray(value.routes)) return [];
      const routes = new Map<number, BrowserRouteRequest>();
      for (const candidate of value.routes) {
        const route = sanitizeRoute(candidate);
        if (route) routes.set(route.targetPort, route);
      }
      return [...routes.values()].slice(-MAX_ROUTES);
    } catch {
      return [];
    }
  }

  private persist(): Promise<void> {
    const next = this.writeQueue.then(() => this.writeNow());
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async writeNow(): Promise<void> {
    const snapshot: BrowserRouteStorage = {
      version: STORAGE_VERSION,
      routes: this.routes!.map((route) => ({ ...route })),
    };
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(temporaryPath, this.filePath);
  }
}

function sanitizeRoute(value: unknown): BrowserRouteRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<BrowserRouteRequest>;
  if (
    !Number.isSafeInteger(candidate.targetPort)
    || Number(candidate.targetPort) < 1
    || Number(candidate.targetPort) > 65_535
  ) return null;
  if (typeof candidate.virtualHostname !== "string") return null;
  const virtualHostname = candidate.virtualHostname.trim().toLowerCase().replace(/\.$/u, "");
  if (
    !virtualHostname
    || virtualHostname.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(virtualHostname)
  ) return null;
  return {
    targetPort: Number(candidate.targetPort),
    virtualHostname,
  };
}
