import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  NativeGitEvidenceAdapter,
  type GitCommandRunner,
  type GitPatchRunner
} from './GitEvidenceAdapter.js';
import { WorktreeFactsCollector } from './WorktreeFactsCollector.js';

describe('WorktreeFactsCollector process budget', () => {
  it('keeps Git command count constant as recent commit count grows', async () => {
    const one = fixtureRunner(1);
    const thirty = fixtureRunner(30);
    await collectorFor(one.run).collect('/repo');
    const thirtyFacts = await collectorFor(thirty.run).collect('/repo');

    expect(one.calls.length).toBeLessThanOrEqual(11);
    // A Worktree evidence generation must have a constant process budget;
    // displaying more commits may change output size, not subprocess count.
    expect(thirty.calls.length).toBeLessThanOrEqual(one.calls.length + 1);
    expect(thirtyFacts.completeness).toBe('complete');
  });

  it('classifies recent commits with one ahead set and one remote-reachability set', async () => {
    const fixture = fixtureRunner(3, { aheadCount: 2, unpushedCount: 1 });
    const facts = await collectorFor(fixture.run).collect('/repo');

    expect(facts.recentCommits.map(({ pushed, mergedIntoBase }) => ({ pushed, mergedIntoBase })))
      .toEqual([
        { pushed: false, mergedIntoBase: false },
        { pushed: true, mergedIntoBase: false },
        { pushed: true, mergedIntoBase: true }
      ]);
  });

  it('fingerprints tracked content, not only status paths', async () => {
    const first = await collectorFor(
      fixtureRunner(1, { diff: 'diff --git a/a b/a\n-old\n+one' }).run
    ).collect('/repo');
    const second = await collectorFor(
      fixtureRunner(1, { diff: 'diff --git a/a b/a\n-old\n+two' }).run
    ).collect('/repo');

    expect(first.dirtyFiles).toEqual(second.dirtyFiles);
    expect(first.dirtyHash).not.toBe(second.dirtyHash);
    expect(first.evidenceFingerprint).not.toBe(second.evidenceFingerprint);
  });

  it('marks failed required reads and invalid requested bases as degraded', async () => {
    const failedStatus = fixtureRunner(1, { failStatus: true });
    const statusFacts = await collectorFor(failedStatus.run).collect('/repo');
    const invalidBase = await collectorFor(failedStatus.run)
      .collect('/repo', 'missing/base');

    expect(statusFacts).toMatchObject({ completeness: 'degraded' });
    expect(statusFacts.diagnostics.join('\n')).toContain('read worktree status');
    expect(invalidBase).toMatchObject({ completeness: 'degraded', baseBranch: null, baseOid: null });
    expect(invalidBase.diagnostics.join('\n')).toContain('resolve requested base missing/base');
  });

  it('parses porcelain-v2 rename records without treating the source path as a file', async () => {
    const status = [
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 new name.ts',
      'old name.ts',
      ''
    ].join('\0');
    const fixture = fixtureRunner(1, { status });
    const facts = await collectorFor(fixture.run).collect('/repo');

    expect(facts.dirtyFiles).toEqual([
      { path: 'new name.ts', status: 'staged', kind: 'R' }
    ]);
  });
});

interface FixtureOptions {
  aheadCount?: number;
  unpushedCount?: number;
  diff?: string;
  status?: string;
  failStatus?: boolean;
}

function fixtureRunner(commitCount: number, options: FixtureOptions = {}): {
  run: GitCommandRunner;
  calls: string[][];
} {
  const shas = Array.from({ length: commitCount }, (_, index) =>
    (index + 1).toString(16).padStart(40, '0'));
  const head = shas[0] ?? 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const ahead = shas.slice(0, options.aheadCount ?? shas.length);
  const unpushed = shas.slice(0, options.unpushedCount ?? 0);
  const calls: string[][] = [];
  const run = vi.fn(async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD^{commit}') return ok(head);
    if (args[0] === 'rev-parse' && args.at(-1)?.endsWith('@{upstream}')) return ok('origin/main');
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('feature');
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args.at(-1) === 'origin/main^{commit}') return ok(base);
    if (args[0] === 'rev-parse' && args[1] === '--verify') return fail('unknown revision');
    if (args[0] === 'rev-list' && args[1] === `${base}..${head}`) return ok(ahead.join('\n'));
    if (args[0] === 'rev-list' && args[1] === '--count') return ok('0');
    if (args[0] === 'rev-list' && args.some((arg) => arg.startsWith('--max-count='))) {
      return ok(unpushed.join('\n'));
    }
    if (args[0] === 'status') {
      return options.failStatus ? fail('status failed') : ok(options.status ?? '');
    }
    if (args[0] === 'diff') return ok(options.diff ?? '');
    if (args[0] === 'log' && args[1] === '-30') {
      return ok(shas.map((sha, index) =>
        `${sha}\x1f${sha.slice(0, 7)}\x1fcommit ${index}\x1f2026-01-01T00:00:00Z`
      ).join('\n'));
    }
    return { code: 1, stdout: '', stderr: 'unexpected command' };
  }) as GitCommandRunner;
  return { run, calls };
}

function ok(stdout: string) {
  return { code: 0, stdout, stderr: '' };
}

function fail(stderr: string) {
  return { code: 1, stdout: '', stderr };
}

function collectorFor(run: GitCommandRunner): WorktreeFactsCollector {
  const runPatch: GitPatchRunner = async (cwd, args, signal) => {
    const result = await run(cwd, args, signal);
    const bytes = Buffer.from(result.stdout);
    return {
      result,
      fullHash: createHash('sha256').update(bytes).digest('hex'),
      fullByteLength: bytes.length
    };
  };
  return new WorktreeFactsCollector({
    createAdapter: () => new NativeGitEvidenceAdapter({ runGit: run, runPatch })
  });
}
