export type GitRefreshCause =
  | { kind: 'initial' | 'poll' | 'resume' | 'manual' | 'context' }
  | { kind: 'filesystem'; occurredAt: number };

export type GitRefreshCadence = 'foreground' | 'background';

export interface GitRefreshIntent<TContext = undefined> {
  key: string;
  cadence: GitRefreshCadence;
  /** New intents marked eager are observed as soon as capacity is available. */
  eager: boolean;
  /** Resource group such as `wsl:Ubuntu`; only maxPerGroup may run at once. */
  group?: string;
  context?: TContext;
  /** Stable identity for context ownership and stale-result rejection. */
  contextId?: string;
}

export interface GitRefreshEvent<TResult> {
  key: string;
  cause: GitRefreshCause;
  result: TResult;
}

export interface GitRefreshCoordinatorOptions {
  intervals: Readonly<Record<GitRefreshCadence, number>>;
  maxConcurrency?: number;
  maxPerGroup?: number;
  jitterRatio?: number;
}

interface RefreshJob<TContext> {
  key: string;
  cadence: GitRefreshCadence;
  group?: string;
  context?: TContext;
  contextId: string;
  dueAt: number;
  sequence: number;
  running: boolean;
  refreshAgain: boolean;
  revision: number;
  pendingCause: GitRefreshCause;
  queuedCause: GitRefreshCause | null;
}

const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_PER_GROUP = 1;
const DEFAULT_JITTER_RATIO = 0.1;
const CADENCE_PRIORITY: Readonly<Record<GitRefreshCadence, number>> = {
  foreground: 2,
  background: 1
};

/**
 * Owns refresh ordering, concurrency, observation ownership, and publication.
 * Callers reconcile intent and consume completed observations; lifecycle and
 * stale-result rules remain local to this Module.
 */
export class GitRefreshCoordinator<TContext = undefined, TResult = void> {
  private readonly jobs = new Map<string, RefreshJob<TContext>>();
  private readonly runningKeys = new Set<string>();
  private readonly activeByGroup = new Map<string, number>();
  private readonly listeners = new Set<(event: GitRefreshEvent<TResult>) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = 0;
  private paused = false;
  private disposed = false;
  private sequence = 0;
  private readonly maxConcurrency: number;
  private readonly maxPerGroup: number;
  private readonly jitterRatio: number;

  constructor(
    private readonly observe: (
      key: string,
      context: TContext | undefined,
      cause: GitRefreshCause
    ) => Promise<TResult>,
    private readonly options: GitRefreshCoordinatorOptions
  ) {
    this.maxConcurrency = positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    this.maxPerGroup = positiveInteger(options.maxPerGroup, DEFAULT_MAX_PER_GROUP);
    this.jitterRatio = Math.max(0, Math.min(0.5, options.jitterRatio ?? DEFAULT_JITTER_RATIO));
  }

  subscribe(listener: (event: GitRefreshEvent<TResult>) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reconcile(intents: readonly GitRefreshIntent<TContext>[]): void {
    if (this.disposed) return;
    const now = Date.now();
    const desired = new Map<string, GitRefreshIntent<TContext>>();
    for (const intent of intents) {
      const key = intent.key.trim();
      if (!key) continue;
      const existing = desired.get(key);
      if (!existing || isMoreUrgent(intent.cadence, existing.cadence)) {
        desired.set(key, { ...intent, key });
      }
    }

    for (const key of this.jobs.keys()) {
      if (!desired.has(key)) this.jobs.delete(key);
    }
    for (const intent of desired.values()) {
      const contextId = intent.contextId ?? '';
      const current = this.jobs.get(intent.key);
      if (!current) {
        const job: RefreshJob<TContext> = {
          key: intent.key,
          cadence: intent.cadence,
          ...(intent.group ? { group: intent.group } : {}),
          ...(intent.context !== undefined ? { context: intent.context } : {}),
          contextId,
          dueAt: intent.eager ? now : now + this.intervalFor(intent.cadence),
          sequence: this.sequence++,
          running: false,
          refreshAgain: false,
          revision: 0,
          pendingCause: intent.eager ? { kind: 'initial' } : { kind: 'poll' },
          queuedCause: null
        };
        this.jobs.set(job.key, job);
        continue;
      }

      const cadenceChanged = current.cadence !== intent.cadence;
      const groupChanged = current.group !== intent.group;
      const contextChanged = current.contextId !== contextId;
      current.cadence = intent.cadence;
      if (intent.group) current.group = intent.group;
      else delete current.group;
      if (intent.context !== undefined) current.context = intent.context;
      else delete current.context;
      current.contextId = contextId;

      if (contextChanged) {
        current.revision += 1;
        if (current.running || this.runningKeys.has(current.key)) {
          current.refreshAgain = true;
          current.queuedCause = mergeCause(current.queuedCause, { kind: 'context' });
        } else {
          current.pendingCause = { kind: 'context' };
          current.dueAt = now;
        }
      } else if (!current.running && (cadenceChanged || groupChanged)) {
        // Recadencing reflects a policy change, not evidence that Git changed.
        current.dueAt = now + this.intervalFor(current.cadence);
      }
    }
    this.schedule();
  }

  /** Coalesces requests and marks an in-flight observation stale. */
  request(key: string, cause: GitRefreshCause): boolean {
    if (this.disposed) return false;
    const job = this.jobs.get(key);
    if (!job) return false;
    job.revision += 1;
    if (job.running || this.runningKeys.has(key)) {
      job.refreshAgain = true;
      job.queuedCause = mergeCause(job.queuedCause, cause);
    } else {
      job.pendingCause = mergeCause(job.pendingCause, cause);
      job.dueAt = Date.now();
    }
    this.schedule();
    return true;
  }

  setPollingPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.clearTimer();
      return;
    }
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.running || this.runningKeys.has(job.key)) continue;
      if (job.cadence === 'foreground') {
        job.pendingCause = mergeCause(job.pendingCause, { kind: 'resume' });
        job.dueAt = now;
      } else if (causePriority(job.pendingCause) >= causePriority({ kind: 'manual' })) {
        // Filesystem/manual/context evidence accumulated while hidden should
        // be observed once on resume. Ordinary fallback polling is staggered.
        job.dueAt = now;
      } else {
        job.pendingCause = { kind: 'poll' };
        job.dueAt = now + this.intervalFor(job.cadence);
      }
    }
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.jobs.clear();
    this.listeners.clear();
  }

  private schedule(): void {
    this.clearTimer();
    if (this.disposed || this.paused || this.active >= this.maxConcurrency) return;
    const eligible = this.eligibleJobs();
    if (eligible.length === 0) return;
    const dueAt = Math.min(...eligible.map((job) => job.dueAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, Math.max(0, dueAt - Date.now()));
  }

  private drain(): void {
    if (this.disposed || this.paused) return;
    while (this.active < this.maxConcurrency) {
      const now = Date.now();
      const next = this.eligibleJobs()
        .filter((job) => job.dueAt <= now)
        .sort(compareJobs)[0];
      if (!next) break;
      this.start(next);
    }
    this.schedule();
  }

  private start(job: RefreshJob<TContext>): void {
    job.running = true;
    this.runningKeys.add(job.key);
    this.active += 1;
    // The intent can change group while this observation is in flight. Keep
    // accounting tied to the permit actually acquired at start time.
    const activeGroup = job.group;
    if (activeGroup) {
      this.activeByGroup.set(activeGroup, (this.activeByGroup.get(activeGroup) ?? 0) + 1);
    }
    const revision = job.revision;
    const context = job.context;
    const cause = job.pendingCause;
    void Promise.resolve()
      .then(() => this.observe(job.key, context, cause))
      .then((result) => {
        const current = this.jobs.get(job.key);
        if (this.disposed || current !== job || revision !== job.revision) return;
        this.publish({ key: job.key, cause, result });
      })
      .catch(() => {
        // The observation Adapter owns user-facing error state. Scheduling
        // survives failure and continues its completion-based cadence.
      })
      .finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.runningKeys.delete(job.key);
        if (activeGroup) decrementGroup(this.activeByGroup, activeGroup);
        const current = this.jobs.get(job.key);
        if (!this.disposed && current === job) {
          job.running = false;
          if (job.refreshAgain) {
            job.refreshAgain = false;
            job.pendingCause = job.queuedCause ?? { kind: 'manual' };
            job.queuedCause = null;
            job.dueAt = Date.now();
          } else {
            job.pendingCause = { kind: 'poll' };
            job.dueAt = Date.now() + this.nextDelay(job);
          }
        }
        this.schedule();
      });
  }

  private publish(event: GitRefreshEvent<TResult>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures are isolated from observation and scheduling.
      }
    }
  }

  private eligibleJobs(): RefreshJob<TContext>[] {
    return Array.from(this.jobs.values()).filter((job) => {
      if (job.running || this.runningKeys.has(job.key)) return false;
      if (!job.group) return true;
      return (this.activeByGroup.get(job.group) ?? 0) < this.maxPerGroup;
    });
  }

  private intervalFor(cadence: GitRefreshCadence): number {
    return Math.max(1, Math.trunc(this.options.intervals[cadence]));
  }

  private nextDelay(job: RefreshJob<TContext>): number {
    const interval = this.intervalFor(job.cadence);
    if (this.jitterRatio === 0) return interval;
    const unit = stableUnit(job.key);
    return Math.max(1, Math.round(interval * (1 + (unit * 2 - 1) * this.jitterRatio)));
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

function compareJobs<TContext>(a: RefreshJob<TContext>, b: RefreshJob<TContext>): number {
  const cadenceDifference = CADENCE_PRIORITY[b.cadence] - CADENCE_PRIORITY[a.cadence];
  if (cadenceDifference !== 0) return cadenceDifference;
  if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
  return a.sequence - b.sequence;
}

function isMoreUrgent(candidate: GitRefreshCadence, current: GitRefreshCadence): boolean {
  return CADENCE_PRIORITY[candidate] > CADENCE_PRIORITY[current];
}

function mergeCause(
  existing: GitRefreshCause | null,
  incoming: GitRefreshCause
): GitRefreshCause {
  if (!existing) return incoming;
  if (existing.kind === 'filesystem' && incoming.kind === 'filesystem') {
    return existing.occurredAt >= incoming.occurredAt ? existing : incoming;
  }
  return causePriority(incoming) >= causePriority(existing) ? incoming : existing;
}

function causePriority(cause: GitRefreshCause): number {
  if (cause.kind === 'filesystem') return 5;
  if (cause.kind === 'context') return 4;
  if (cause.kind === 'manual') return 3;
  if (cause.kind === 'resume') return 2;
  if (cause.kind === 'initial') return 1;
  return 0;
}

function decrementGroup(activeByGroup: Map<string, number>, group: string): void {
  const remaining = (activeByGroup.get(group) ?? 1) - 1;
  if (remaining > 0) activeByGroup.set(group, remaining);
  else activeByGroup.delete(group);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = Math.trunc(value ?? fallback);
  return resolved > 0 ? resolved : fallback;
}

function stableUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}
