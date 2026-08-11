import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureChangeEvent } from '@shared/types/features.js';
import {
  FeatureArtifactObservation,
  type ArtifactStamp,
  type FeatureArtifactDirectoryEntry,
  type FeatureArtifactFs
} from './FeatureArtifactObservation.js';

const SCOPE = { cwd: '/repo', runMode: 'windows' as const };

afterEach(() => {
  vi.useRealTimers();
});

describe('FeatureArtifactObservation', () => {
  it('indexes only the fixed-depth semantic artifact grammar', async () => {
    const artifactFs = fixtureFs();
    const observation = new FeatureArtifactObservation({ fs: artifactFs });

    const index = await observation.observeNow(SCOPE);

    expect(index.features).toEqual([
      { slug: 'alpha', hasCoverage: true, hasIssues: true, hasPlans: true },
      { slug: 'empty', hasCoverage: false, hasIssues: false, hasPlans: false }
    ]);
    expect(index.plans).toEqual([{
      relativePath: 'docs/plans/alpha-feature.md',
      name: 'alpha-feature',
      slugs: ['alpha']
    }]);
    expect(index.scratch).toEqual([{
      slug: 'alpha',
      issues: [{
        name: '01-first.md',
        relativePath: '.scratch/alpha/issues/01-first.md',
        stamp: present(4)
      }],
      playwright: {
        relativePath: '.scratch/alpha/playwright-e2e.md',
        stamp: present(5)
      }
    }]);
    expect(artifactFs.listCalls).toEqual(expect.arrayContaining([
      '/repo/docs/grill',
      '/repo/docs/plans',
      '/repo/.scratch',
      '/repo/.scratch/alpha/issues',
      '/repo/.scratch/noise/issues'
    ]));
    expect(artifactFs.listCalls).not.toContain('/repo/docs/agents');
    expect(artifactFs.listCalls.some((path) => path.includes('/archive/'))).toBe(false);
    expect(artifactFs.stampCalls).not.toContain('/repo/CONTEXT.md');
    expect(artifactFs.stampCalls).not.toContain('/repo/docs/plans/alpha-feature.md');
    observation.dispose();
  });

  it('ignores irrelevant nesting and plan content while detecting relevant edits', async () => {
    const artifactFs = fixtureFs();
    const observation = new FeatureArtifactObservation({ fs: artifactFs });
    const first = await observation.observeNow(SCOPE);
    const callCount = artifactFs.listCalls.length + artifactFs.stampCalls.length;

    artifactFs.setList('/repo/.scratch/alpha/issues/archive/deep', [file('ignored.md')]);
    artifactFs.setList('/repo/docs/grill/alpha/notes/deep', [file('ignored.md')]);
    artifactFs.setStamp('/repo/CONTEXT.md', present(900));
    artifactFs.setStamp('/repo/docs/plans/alpha-feature.md', present(901));
    const irrelevant = await observation.observeNow(SCOPE);

    expect(irrelevant.revision).toBe(first.revision);
    expect(artifactFs.listCalls.length + artifactFs.stampCalls.length).toBe(callCount * 2);
    expect(artifactFs.listCalls.some((path) => path.includes('/archive/'))).toBe(false);

    artifactFs.setStamp('/repo/.scratch/alpha/issues/01-first.md', present(902));
    const relevant = await observation.observeNow(SCOPE);
    expect(relevant.revision).not.toBe(first.revision);
    observation.dispose();
  });

  it('coalesces physical observations and serves only the exact cached revision', async () => {
    const artifactFs = fixtureFs();
    const observation = new FeatureArtifactObservation({ fs: artifactFs });

    const [first, second] = await Promise.all([
      observation.observeNow(SCOPE),
      observation.observeNow(SCOPE)
    ]);

    expect(first).toBe(second);
    expect(artifactFs.listCalls.filter((path) => path === '/repo/docs/grill')).toHaveLength(1);
    expect(observation.current(SCOPE, first.revision)).toBe(first);
    expect(observation.current(SCOPE, 'different')).toBeNull();
    observation.dispose();
  });

  it('owns one ref-counted observation loop and publishes only changed revisions', async () => {
    vi.useFakeTimers();
    const artifactFs = fixtureFs();
    const observation = new FeatureArtifactObservation({
      fs: artifactFs,
      intervalMs: 100,
      retireAfterMs: 1_000
    });
    const events: FeatureChangeEvent[] = [];
    observation.onChange((event) => events.push(event));

    await observation.observeNow(SCOPE);

    const releaseA = observation.acquire(SCOPE);
    const releaseB = observation.acquire(SCOPE);
    expect(events).toEqual([]);
    expect(artifactFs.listCalls.filter((path) => path === '/repo/docs/grill')).toHaveLength(1);

    artifactFs.setStamp('/repo/docs/grill/alpha/coverage-map.md', present(77));
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cwd: '/repo',
      runMode: 'windows',
      kind: 'features'
    });
    expect(events[0]?.revision).toHaveLength(64);

    releaseA();
    await vi.advanceTimersByTimeAsync(100);
    expect(artifactFs.listCalls.filter((path) => path === '/repo/docs/grill')).toHaveLength(3);
    releaseB();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(artifactFs.listCalls.filter((path) => path === '/repo/docs/grill')).toHaveLength(3);
    observation.dispose();
  });

  it('bounds concurrent metadata calls across large semantic indexes', async () => {
    const artifactFs = fixtureFs();
    artifactFs.setList('/repo/docs/grill', Array.from(
      { length: 40 },
      (_, index) => directory(`feature-${index}`)
    ));
    artifactFs.stampDelayMs = 2;
    const observation = new FeatureArtifactObservation({ fs: artifactFs, ioConcurrency: 4 });

    await observation.observeNow(SCOPE);

    expect(artifactFs.maxConcurrentStamps).toBeGreaterThan(1);
    expect(artifactFs.maxConcurrentStamps).toBeLessThanOrEqual(4);
    observation.dispose();
  });
});

class FakeArtifactFs implements FeatureArtifactFs {
  readonly listCalls: string[] = [];
  readonly stampCalls: string[] = [];
  stampDelayMs = 0;
  maxConcurrentStamps = 0;
  private concurrentStamps = 0;
  private readonly listings = new Map<string, FeatureArtifactDirectoryEntry[]>();
  private readonly stamps = new Map<string, ArtifactStamp>();

  setList(path: string, entries: FeatureArtifactDirectoryEntry[]): void {
    this.listings.set(path, entries);
  }

  setStamp(path: string, stamp: ArtifactStamp): void {
    this.stamps.set(path, stamp);
  }

  async list(directory: string): Promise<FeatureArtifactDirectoryEntry[]> {
    this.listCalls.push(directory);
    return [...(this.listings.get(directory) ?? [])];
  }

  async stamp(filePath: string): Promise<ArtifactStamp> {
    this.stampCalls.push(filePath);
    this.concurrentStamps += 1;
    this.maxConcurrentStamps = Math.max(this.maxConcurrentStamps, this.concurrentStamps);
    try {
      if (this.stampDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.stampDelayMs));
      }
      return this.stamps.get(filePath) ?? { state: 'missing' };
    } finally {
      this.concurrentStamps -= 1;
    }
  }
}

function fixtureFs(): FakeArtifactFs {
  const artifactFs = new FakeArtifactFs();
  artifactFs.setList('/repo/docs/grill', [directory('empty'), file('README.md'), directory('alpha')]);
  artifactFs.setList('/repo/.scratch', [directory('noise'), directory('alpha')]);
  artifactFs.setList('/repo/docs/plans', [
    file('notes.txt'),
    file('grill-old-migration.md'),
    file('alpha-feature.md')
  ]);
  artifactFs.setList('/repo/.scratch/alpha/issues', [
    directory('archive'),
    file('ignore.txt'),
    file('01-first.md')
  ]);
  artifactFs.setList('/repo/.scratch/noise/issues', []);
  artifactFs.setStamp('/repo/CLAUDE.md', present(1));
  artifactFs.setStamp('/repo/docs/agents/issue-tracker.md', present(2));
  artifactFs.setStamp('/repo/docs/grill/alpha/coverage-map.md', present(3));
  artifactFs.setStamp('/repo/.scratch/alpha/issues/01-first.md', present(4));
  artifactFs.setStamp('/repo/.scratch/alpha/playwright-e2e.md', present(5));
  return artifactFs;
}

function present(value: number): ArtifactStamp {
  return {
    state: 'present',
    mtimeNs: String(value),
    ctimeNs: String(value),
    size: String(value)
  };
}

function file(name: string): FeatureArtifactDirectoryEntry {
  return { name, kind: 'file' };
}

function directory(name: string): FeatureArtifactDirectoryEntry {
  return { name, kind: 'directory' };
}
