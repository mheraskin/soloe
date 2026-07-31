import type { RuntimeUsageSnapshot } from "@soloe/protocol";
import type {
  SystemUsageAvailability,
  SystemUsageComponent,
  SystemUsageRequest,
  SystemUsageSnapshot,
} from "../../../shared/types/system.js";

export interface BackendUsageObservationOptions {
  collectServerUsage(): Promise<RuntimeUsageSnapshot>;
  collectRuntimeUsage?(): Promise<RuntimeUsageSnapshot>;
  backendPlacement?: "native" | "wsl";
  now?: () => number;
  cacheMs?: number;
}

interface TimedSnapshot {
  value: SystemUsageSnapshot;
  expiresAt: number;
}

const DEFAULT_CACHE_MS = 1_000;

export class BackendUsageObservation {
  private readonly now: () => number;
  private readonly cacheMs: number;
  private cached: TimedSnapshot | null = null;
  private inFlight: Promise<SystemUsageSnapshot> | null = null;

  constructor(private readonly options: BackendUsageObservationOptions) {
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  }

  observe(_request: SystemUsageRequest = {}): Promise<SystemUsageSnapshot> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.value);
    }
    if (this.inFlight) return this.inFlight;
    const request = this.collect().then((value) => {
      this.cached = { value, expiresAt: this.now() + this.cacheMs };
      return value;
    }).finally(() => {
      if (this.inFlight === request) this.inFlight = null;
    });
    this.inFlight = request;
    return request;
  }

  reset(): void {
    this.cached = null;
  }

  private async collect(): Promise<SystemUsageSnapshot> {
    const [server, runtime] = await Promise.all([
      settleUsage(this.options.collectServerUsage),
      this.options.collectRuntimeUsage
        ? settleUsage(this.options.collectRuntimeUsage)
        : Promise.resolve(unavailableRuntime("runtime usage is not connected")),
    ]);
    const components: SystemUsageComponent[] = [
      ...mapServerComponents(server),
      ...mapRuntimeComponents(runtime),
    ];
    if (this.options.backendPlacement === "wsl") {
      components.push({
        kind: "wsl-supervisor",
        availability: "unavailable",
        cpuPercent: null,
        memoryBytes: null,
        processCount: null,
        message: "the Windows-side WSL supervisor is outside the backend process tree",
      });
    }
    const measured = [server, runtime].filter(
      (snapshot) => snapshot.availability !== "unavailable",
    );
    const availability = aggregateAvailability(components, measured.length);

    return {
      scope: "backend",
      availability,
      backendPlacement: this.options.backendPlacement ?? "native",
      cpuPercent: sumNullable(measured.map((snapshot) => snapshot.cpuPercent), 1),
      memoryBytes: sumNullable(measured.map((snapshot) => snapshot.memoryBytes)),
      processCount: sumNullable(measured.map((snapshot) => snapshot.processCount)),
      electronProcessCount: null,
      childProcessCount: sumNullable([
        childProcessCount(server),
        childProcessCount(runtime),
      ]),
      components,
      wslActive: this.options.backendPlacement === "wsl",
      wsl: null,
      sampledAt: newestSampleTime(server.sampledAt, runtime.sampledAt),
      ...(availability === "available"
        ? {}
        : {
            message:
              availability === "degraded"
                ? "some backend process metrics are unavailable"
                : "backend process metrics are unavailable",
          }),
    };
  }
}

async function settleUsage(
  collect: () => Promise<RuntimeUsageSnapshot>,
): Promise<RuntimeUsageSnapshot> {
  try {
    return await collect();
  } catch (error) {
    return unavailableRuntime(
      error instanceof Error ? error.message : "process usage unavailable",
    );
  }
}

function unavailableRuntime(message: string): RuntimeUsageSnapshot {
  return {
    availability: "unavailable",
    cpuPercent: null,
    memoryBytes: null,
    processCount: null,
    components: [],
    sampledAt: new Date().toISOString(),
    message,
  };
}

function mapServerComponents(
  snapshot: RuntimeUsageSnapshot,
): SystemUsageComponent[] {
  if (snapshot.components.length === 0) {
    return [
      unavailableComponent(
        "application-server",
        snapshot.message ?? "application server metrics unavailable",
      ),
    ];
  }
  return snapshot.components.map((component) => ({
    ...component,
    kind:
      component.kind === "runtime" ? "application-server" : "agent-worker",
  }));
}

function mapRuntimeComponents(
  snapshot: RuntimeUsageSnapshot,
): SystemUsageComponent[] {
  if (snapshot.components.length === 0) {
    return [
      unavailableComponent(
        "runtime",
        snapshot.message ?? "runtime metrics unavailable",
      ),
      unavailableComponent("agent-pty", "runtime process tree unavailable"),
    ];
  }
  return snapshot.components.map((component) => ({ ...component }));
}

function unavailableComponent(
  kind: SystemUsageComponent["kind"],
  message: string,
): SystemUsageComponent {
  return {
    kind,
    availability: "unavailable",
    cpuPercent: null,
    memoryBytes: null,
    processCount: null,
    message,
  };
}

function aggregateAvailability(
  components: SystemUsageComponent[],
  measuredSnapshots: number,
): SystemUsageAvailability {
  if (measuredSnapshots === 0) return "unavailable";
  return components.some((component) => component.availability !== "available")
    ? "degraded"
    : "available";
}

function childProcessCount(snapshot: RuntimeUsageSnapshot): number | null {
  const child = snapshot.components.find(
    (component) => component.kind === "agent-pty",
  );
  return child?.processCount ?? null;
}

function sumNullable(
  values: Array<number | null>,
  digits?: number,
): number | null {
  const available = values.filter((value): value is number => value !== null);
  if (available.length === 0) return null;
  const total = available.reduce((sum, value) => sum + value, 0);
  if (digits === undefined) return total;
  const factor = 10 ** digits;
  return Math.round(total * factor) / factor;
}

function newestSampleTime(...values: string[]): string {
  return [...values].sort().at(-1) ?? new Date().toISOString();
}
