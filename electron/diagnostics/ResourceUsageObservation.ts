import type {
  SystemUsageRequest,
  SystemUsageSnapshot,
  WslUsageSnapshot
} from '@shared/types/system.js';

type AppUsageSnapshot = Omit<SystemUsageSnapshot, 'wslActive' | 'wsl'>;

export interface ResourceUsageObservationAdapters {
  collectAppUsage(): Promise<AppUsageSnapshot>;
  getRunningWslDistros(): Promise<string[]>;
  sampleWsl(distroCount: number): Promise<WslUsageSnapshot | null>;
  resetWsl(): void;
  now?(): number;
  appCacheMs?: number;
  distroCacheMs?: number;
  wslCacheMs?: number;
}

interface TimedValue<T> {
  value: T;
  expiresAt: number;
}

interface WslDetailInFlight {
  distroCount: number;
  request: Promise<WslUsageSnapshot | null>;
}

const DEFAULT_APP_CACHE_MS = 1_000;
const DEFAULT_DISTRO_CACHE_MS = 1_000;
const DEFAULT_WSL_CACHE_MS = 1_000;

/**
 * Produces demand-qualified resource observations without owning a timer.
 * Summary observations never invoke the expensive WSL adapter. Detail
 * observations serialize and briefly share one VM-wide sample.
 */
export class ResourceUsageObservation {
  private readonly now: () => number;
  private readonly appCacheMs: number;
  private readonly distroCacheMs: number;
  private readonly wslCacheMs: number;
  private appCache: TimedValue<AppUsageSnapshot> | null = null;
  private distroCache: TimedValue<string[]> | null = null;
  private wslCache: TimedValue<WslUsageSnapshot> | null = null;
  private appInFlight: Promise<AppUsageSnapshot> | null = null;
  private distrosInFlight: Promise<string[]> | null = null;
  private wslInFlight: WslDetailInFlight | null = null;
  private observedDistroCount = 0;
  private revision = 0;

  constructor(private readonly adapters: ResourceUsageObservationAdapters) {
    this.now = adapters.now ?? Date.now;
    this.appCacheMs = adapters.appCacheMs ?? DEFAULT_APP_CACHE_MS;
    this.distroCacheMs = adapters.distroCacheMs ?? DEFAULT_DISTRO_CACHE_MS;
    this.wslCacheMs = adapters.wslCacheMs ?? DEFAULT_WSL_CACHE_MS;
  }

  async observe(request: SystemUsageRequest = {}): Promise<SystemUsageSnapshot> {
    const [appUsage, distros] = await Promise.all([
      this.appUsage(),
      this.runningDistros()
    ]);
    const distroCount = new Set(distros.map((distro) => distro.trim()).filter(Boolean)).size;
    this.reconcileDistroCount(distroCount);

    const wsl = distroCount === 0
      ? null
      : request.detail === 'wsl'
        ? await this.wslDetail(distroCount)
        : this.cachedWslDetail(distroCount);

    return {
      ...appUsage,
      wslActive: distroCount > 0,
      wsl
    };
  }

  reset(): void {
    this.revision += 1;
    this.appCache = null;
    this.distroCache = null;
    this.wslCache = null;
    this.observedDistroCount = 0;
    this.adapters.resetWsl();
  }

  private async appUsage(): Promise<AppUsageSnapshot> {
    const cached = this.unexpired(this.appCache);
    if (cached) return cached;
    if (this.appInFlight) return this.appInFlight;
    const revision = this.revision;
    const request = this.adapters.collectAppUsage().then((value) => {
      if (revision === this.revision) {
        this.appCache = { value, expiresAt: this.now() + this.appCacheMs };
      }
      return value;
    }).finally(() => {
      if (this.appInFlight === request) this.appInFlight = null;
    });
    this.appInFlight = request;
    return request;
  }

  private async runningDistros(): Promise<string[]> {
    const cached = this.unexpired(this.distroCache);
    if (cached) return cached;
    if (this.distrosInFlight) return this.distrosInFlight;
    const revision = this.revision;
    const request = this.adapters.getRunningWslDistros().then((value) => {
      if (revision === this.revision) {
        this.distroCache = { value, expiresAt: this.now() + this.distroCacheMs };
      }
      return value;
    }).finally(() => {
      if (this.distrosInFlight === request) this.distrosInFlight = null;
    });
    this.distrosInFlight = request;
    return request;
  }

  private async wslDetail(distroCount: number): Promise<WslUsageSnapshot | null> {
    const cached = this.cachedWslDetail(distroCount);
    if (cached) return cached;

    // Share both successful and failed physical probes. A count transition may
    // wait for the old generation, but same-generation callers receive the
    // exact same result and never create a retry cascade.
    const inFlight = this.wslInFlight;
    if (inFlight) {
      const result = await inFlight.request;
      if (inFlight.distroCount === distroCount) return result;
      return this.wslDetail(distroCount);
    }

    const revision = this.revision;
    const request = this.adapters.sampleWsl(distroCount).catch(() => null).then((value) => {
      if (
        value
        && revision === this.revision
        && distroCount === this.observedDistroCount
      ) {
        this.wslCache = { value, expiresAt: this.now() + this.wslCacheMs };
      }
      return value;
    }).finally(() => {
      if (this.wslInFlight?.request === request) this.wslInFlight = null;
    });
    this.wslInFlight = { distroCount, request };
    return request;
  }

  private reconcileDistroCount(distroCount: number): void {
    if (distroCount === this.observedDistroCount) return;
    this.observedDistroCount = distroCount;
    this.wslCache = null;
    this.adapters.resetWsl();
  }

  private cachedWslDetail(distroCount: number): WslUsageSnapshot | null {
    const cached = this.unexpired(this.wslCache);
    return cached?.distroCount === distroCount ? cached : null;
  }

  private unexpired<T>(entry: TimedValue<T> | null): T | null {
    if (!entry || entry.expiresAt <= this.now()) return null;
    return entry.value;
  }
}
