import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { RunMode } from '../../../../shared/types/sessions.js';
import type {
  FeatureChangeEvent,
  FeaturePlanEntry,
  FeatureSlug
} from '../../../../shared/types/features.js';
import { worktreeIdentityKey } from '../../../../shared/worktree-identity.js';
import {
  joinHostPath as joinPath,
  worktreeHostPath as hostPathFor
} from '../runtime/wsl-paths.js';

export interface FeatureArtifactScope {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
}

export type ArtifactStamp =
  | { state: 'present'; mtimeNs: string; ctimeNs: string; size: string }
  | { state: 'missing' };

export interface FeatureArtifactDirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'other';
}

export interface FeatureArtifactFs {
  list(directory: string): Promise<FeatureArtifactDirectoryEntry[]>;
  stamp(filePath: string): Promise<ArtifactStamp>;
}

export interface IndexedFeaturePlan extends FeaturePlanEntry {
  slugs: readonly string[];
}

export interface IndexedFeatureIssueSet {
  slug: string;
  issues: readonly { name: string; relativePath: string; stamp: ArtifactStamp }[];
  playwright: { relativePath: string; stamp: ArtifactStamp } | null;
}

export interface FeatureArtifactIndex {
  scope: FeatureArtifactScope;
  revision: string;
  setup: { claude: ArtifactStamp; agents: ArtifactStamp };
  tracker: ArtifactStamp;
  grill: readonly { slug: string; coverage: ArtifactStamp }[];
  plans: readonly IndexedFeaturePlan[];
  scratch: readonly IndexedFeatureIssueSet[];
  features: readonly FeatureSlug[];
  observedAt: number;
}

interface ObservationState {
  scope: FeatureArtifactScope;
  refCount: number;
  generation: number;
  timer: NodeJS.Timeout | null;
  retireTimer: NodeJS.Timeout | null;
  inFlight: Promise<FeatureArtifactIndex> | null;
  current: FeatureArtifactIndex | null;
  publishedRevision: string | null;
}

interface FeatureArtifactObservationOptions {
  fs?: FeatureArtifactFs;
  intervalMs?: number;
  retireAfterMs?: number;
  ioConcurrency?: number;
  now?: () => number;
}

interface RevisionTarget {
  kind: 'claude' | 'agents' | 'tracker' | 'coverage' | 'issue' | 'playwright';
  absolutePath: string;
  relativePath: string;
  slug?: string;
  name?: string;
}

interface ResolvedRevisionTarget extends RevisionTarget {
  stamp: ArtifactStamp;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_RETIRE_AFTER_MS = 10_000;
const DEFAULT_IO_CONCURRENCY = 8;
const MISSING_STAMP: ArtifactStamp = { state: 'missing' };

/**
 * Owns the bounded Feature Artifact grammar, runtime-qualified observation
 * lifecycle, deterministic revision, and change publication for each Worktree.
 */
export class FeatureArtifactObservation {
  private readonly artifactFs: FeatureArtifactFs;
  private readonly intervalMs: number;
  private readonly retireAfterMs: number;
  private readonly ioConcurrency: number;
  private readonly now: () => number;
  private readonly states = new Map<string, ObservationState>();
  private readonly listeners = new Set<(event: FeatureChangeEvent) => void>();

  constructor(options: FeatureArtifactObservationOptions = {}) {
    this.artifactFs = options.fs ?? nodeFeatureArtifactFs;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.retireAfterMs = options.retireAfterMs ?? DEFAULT_RETIRE_AFTER_MS;
    this.ioConcurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.ioConcurrency) || this.ioConcurrency < 1) {
      throw new Error('ioConcurrency must be a positive integer');
    }
  }

  onChange(listener: (event: FeatureChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  acquire(scope: FeatureArtifactScope): () => void {
    if (!scope.cwd?.trim()) return () => undefined;
    const id = this.identity(scope);
    const state = this.stateFor(id, scope);
    this.cancelRetirement(state);
    state.refCount += 1;
    if (state.refCount === 1) {
      state.generation += 1;
      if (state.current) {
        state.publishedRevision = state.current.revision;
        this.schedule(id, state, state.generation);
      } else {
        void this.observePeriodic(id, state, state.generation);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(id, state);
    };
  }

  /** Performs or joins one fresh physical observation without publishing it. */
  async observeNow(scope: FeatureArtifactScope): Promise<FeatureArtifactIndex> {
    if (!scope.cwd?.trim()) throw new Error('cwd is required');
    const id = this.identity(scope);
    const state = this.stateFor(id, scope);
    this.cancelRetirement(state);
    try {
      return await this.observeFresh(state);
    } finally {
      if (state.refCount === 0) this.scheduleRetirement(id, state);
    }
  }

  /** Returns only the exact cached revision requested by a change event. */
  current(scope: FeatureArtifactScope, revision?: string): FeatureArtifactIndex | null {
    const state = this.states.get(this.identity(scope));
    const current = state?.current ?? null;
    if (!current || (revision && current.revision !== revision)) return null;
    return current;
  }

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      if (state.retireTimer) clearTimeout(state.retireTimer);
      state.generation += 1;
      state.refCount = 0;
    }
    this.states.clear();
    this.listeners.clear();
  }

  private async observePeriodic(
    id: string,
    state: ObservationState,
    generation: number
  ): Promise<void> {
    try {
      const index = await this.observeFresh(state);
      if (!this.isActive(id, state, generation)) return;
      const previous = state.publishedRevision;
      state.publishedRevision = index.revision;
      if (previous !== null && previous !== index.revision) {
        this.broadcast({
          cwd: state.scope.cwd,
          runMode: state.scope.runMode,
          ...(state.scope.wslDistro ? { wslDistro: state.scope.wslDistro } : {}),
          kind: 'features',
          revision: index.revision
        });
      }
    } catch {
      // Retain the last good Index. Transient UNC/access failures must not
      // masquerade as artifact deletion or replace the publication baseline.
    } finally {
      if (this.isActive(id, state, generation)) this.schedule(id, state, generation);
    }
  }

  private observeFresh(state: ObservationState): Promise<FeatureArtifactIndex> {
    if (state.inFlight) return state.inFlight;
    const request = this.buildIndex(state.scope).then((index) => {
      state.current = index;
      return index;
    }).finally(() => {
      if (state.inFlight === request) state.inFlight = null;
    });
    state.inFlight = request;
    return request;
  }

  private async buildIndex(scope: FeatureArtifactScope): Promise<FeatureArtifactIndex> {
    const host = hostPathFor(scope.cwd, scope.runMode, scope.wslDistro);
    const [grillEntries, scratchEntries, planEntries] = await Promise.all([
      this.artifactFs.list(joinPath(host, 'docs', 'grill')),
      this.artifactFs.list(joinPath(host, '.scratch')),
      this.artifactFs.list(joinPath(host, 'docs', 'plans'))
    ]);
    const grillSlugs = directoryNames(grillEntries);
    const scratchSlugs = directoryNames(scratchEntries);
    const eligiblePlans = planEntries
      .filter((entry) => entry.kind === 'file' && eligiblePlanName(entry.name))
      .map((entry) => entry.name)
      .sort(compareText);

    const scratchMembership = await mapConcurrent(
      scratchSlugs,
      this.ioConcurrency,
      async (slug) => ({
        slug,
        entries: await this.artifactFs.list(joinPath(host, '.scratch', slug, 'issues'))
      })
    );

    const targets: RevisionTarget[] = [
      target('claude', 'CLAUDE.md'),
      target('agents', 'AGENTS.md'),
      target('tracker', 'docs/agents/issue-tracker.md')
    ];
    for (const slug of grillSlugs) {
      targets.push(target(
        'coverage',
        `docs/grill/${slug}/coverage-map.md`,
        slug
      ));
    }
    for (const membership of scratchMembership) {
      for (const entry of membership.entries) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue;
        targets.push(target(
          'issue',
          `.scratch/${membership.slug}/issues/${entry.name}`,
          membership.slug,
          entry.name
        ));
      }
      targets.push(target(
        'playwright',
        `.scratch/${membership.slug}/playwright-e2e.md`,
        membership.slug,
        'playwright-e2e.md'
      ));
    }

    function target(
      kind: RevisionTarget['kind'],
      relativePath: string,
      slug?: string,
      name?: string
    ): RevisionTarget {
      return {
        kind,
        relativePath,
        absolutePath: joinPath(host, ...relativePath.split('/')),
        ...(slug ? { slug } : {}),
        ...(name ? { name } : {})
      };
    }

    const resolved = await mapConcurrent(
      targets,
      this.ioConcurrency,
      async (entry): Promise<ResolvedRevisionTarget> => ({
        ...entry,
        stamp: await this.artifactFs.stamp(entry.absolutePath)
      })
    );
    const byKind = (kind: RevisionTarget['kind']) => resolved.filter((entry) => entry.kind === kind);
    const claude = byKind('claude')[0]?.stamp ?? MISSING_STAMP;
    const agents = byKind('agents')[0]?.stamp ?? MISSING_STAMP;
    const tracker = byKind('tracker')[0]?.stamp ?? MISSING_STAMP;
    const grill = grillSlugs.map((slug) => ({
      slug,
      coverage: byKind('coverage').find((entry) => entry.slug === slug)?.stamp ?? MISSING_STAMP
    }));
    const scratch = scratchSlugs.map((slug): IndexedFeatureIssueSet => {
      const issues = byKind('issue')
        .filter((entry) => entry.slug === slug)
        .map((entry) => ({
          name: entry.name ?? entry.relativePath.split('/').pop() ?? entry.relativePath,
          relativePath: entry.relativePath,
          stamp: entry.stamp
        }))
        .sort((a, b) => compareText(a.name, b.name));
      const playwrightTarget = byKind('playwright').find((entry) => entry.slug === slug);
      return {
        slug,
        issues,
        playwright: playwrightTarget && playwrightTarget.stamp.state === 'present'
          ? { relativePath: playwrightTarget.relativePath, stamp: playwrightTarget.stamp }
          : null
      };
    }).filter((entry) => entry.issues.length > 0 || entry.playwright !== null);
    const { features, plans } = materializeFeatureMembership(grill, scratch, eligiblePlans);
    const revision = digestIndex({ claude, agents, tracker, grill, plans, scratch });
    return {
      scope: { ...scope },
      revision,
      setup: { claude, agents },
      tracker,
      grill,
      plans,
      scratch,
      features,
      observedAt: this.now()
    };
  }

  private stateFor(id: string, scope: FeatureArtifactScope): ObservationState {
    const existing = this.states.get(id);
    if (existing) return existing;
    const state: ObservationState = {
      scope: { ...scope },
      refCount: 0,
      generation: 0,
      timer: null,
      retireTimer: null,
      inFlight: null,
      current: null,
      publishedRevision: null
    };
    this.states.set(id, state);
    return state;
  }

  private release(id: string, state: ObservationState): void {
    if (this.states.get(id) !== state || state.refCount <= 0) return;
    state.refCount -= 1;
    if (state.refCount > 0) return;
    state.generation += 1;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    this.scheduleRetirement(id, state);
  }

  private schedule(id: string, state: ObservationState, generation: number): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.observePeriodic(id, state, generation);
    }, this.intervalMs);
    state.timer.unref?.();
  }

  private scheduleRetirement(id: string, state: ObservationState): void {
    if (state.retireTimer || state.refCount > 0) return;
    state.retireTimer = setTimeout(() => {
      state.retireTimer = null;
      if (state.refCount === 0 && !state.inFlight && this.states.get(id) === state) {
        this.states.delete(id);
      } else if (state.refCount === 0) {
        this.scheduleRetirement(id, state);
      }
    }, this.retireAfterMs);
    state.retireTimer.unref?.();
  }

  private cancelRetirement(state: ObservationState): void {
    if (!state.retireTimer) return;
    clearTimeout(state.retireTimer);
    state.retireTimer = null;
  }

  private isActive(id: string, state: ObservationState, generation: number): boolean {
    return this.states.get(id) === state
      && state.refCount > 0
      && state.generation === generation;
  }

  private identity(scope: FeatureArtifactScope): string {
    return worktreeIdentityKey(scope.cwd, scope);
  }

  private broadcast(event: FeatureChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One observer must not break publication to the rest.
      }
    }
  }
}

export const nodeFeatureArtifactFs: FeatureArtifactFs = {
  async list(directory) {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return entries.map((entry): FeatureArtifactDirectoryEntry => ({
        name: entry.name,
        kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
      })).sort((a, b) => compareText(a.name, b.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },
  async stamp(filePath) {
    try {
      const stat = await fs.stat(filePath, { bigint: true });
      if (!stat.isFile()) return MISSING_STAMP;
      return {
        state: 'present',
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        size: stat.size.toString()
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return MISSING_STAMP;
      throw error;
    }
  }
};

function materializeFeatureMembership(
  grill: readonly { slug: string; coverage: ArtifactStamp }[],
  scratch: readonly IndexedFeatureIssueSet[],
  planNames: readonly string[]
): { features: FeatureSlug[]; plans: IndexedFeaturePlan[] } {
  const features = new Map<string, FeatureSlug>();
  const plansByName = new Map<string, Set<string>>();
  const ensure = (slug: string): FeatureSlug => {
    let feature = features.get(slug);
    if (!feature) {
      feature = { slug, hasCoverage: false, hasIssues: false, hasPlans: false };
      features.set(slug, feature);
    }
    return feature;
  };
  for (const entry of grill) {
    ensure(entry.slug).hasCoverage = entry.coverage.state === 'present';
  }
  for (const entry of scratch) ensure(entry.slug).hasIssues = true;
  for (const name of planNames) {
    const stem = name.replace(/\.md$/i, '');
    const matched: string[] = [];
    for (const slug of features.keys()) {
      if (planMatchesSlug(stem, slug)) matched.push(slug);
    }
    if (matched.length === 0) {
      const candidate = guessSlugFromPlan(stem);
      if (candidate) matched.push(candidate);
    }
    const slugs = plansByName.get(name) ?? new Set<string>();
    for (const slug of matched) {
      ensure(slug).hasPlans = true;
      slugs.add(slug);
    }
    plansByName.set(name, slugs);
  }
  return {
    features: [...features.values()].sort((a, b) => compareText(a.slug, b.slug)),
    plans: planNames.map((name) => ({
      relativePath: `docs/plans/${name}`,
      name: name.replace(/\.md$/i, ''),
      slugs: [...(plansByName.get(name) ?? [])].sort(compareText)
    }))
  };
}

function digestIndex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function eligiblePlanName(name: string): boolean {
  if (!name.toLowerCase().endsWith('.md')) return false;
  return !(name.startsWith('grill-') && name.includes('-migration.md'));
}

function planMatchesSlug(planStem: string, slug: string): boolean {
  return planStem === slug
    || planStem.startsWith(`${slug}-`)
    || planStem.startsWith(`${slug}_`);
}

function guessSlugFromPlan(stem: string): string | null {
  if (!stem.includes('-')) return null;
  const stripped = stem.replace(/-(feature|ux|spec|design|plan|notes)$/i, '');
  return stripped.includes(' ') ? null : stripped;
}

function directoryNames(entries: readonly FeatureArtifactDirectoryEntry[]): string[] {
  return entries
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.name)
    .sort(compareText);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b);
}

async function mapConcurrent<T, TResult>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  if (values.length === 0) return [];
  const results = new Array<TResult>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index] as T;
        results[index] = await work(value, index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
