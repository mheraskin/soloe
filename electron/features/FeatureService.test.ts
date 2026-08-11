import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureArtifactIndex } from './FeatureArtifactObservation.js';
import { FeatureService, type FeatureArtifactIndexSource } from './FeatureService.js';

let root = '';
let index: FeatureArtifactIndex;
let source: FeatureArtifactIndexSource & {
  observeNow: ReturnType<typeof vi.fn>;
  current: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-features-'));
  await fs.mkdir(path.join(root, 'docs', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'grill', 'alpha'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.mkdir(path.join(root, '.scratch', 'alpha', 'issues'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, 'CLAUDE.md'), '# Instructions\n\n## Agent skills\n', 'utf8'),
    fs.writeFile(
      path.join(root, 'docs', 'agents', 'issue-tracker.md'),
      '# Issue tracker\n\nUse local markdown in .scratch/.\n',
      'utf8'
    ),
    fs.writeFile(
      path.join(root, 'docs', 'grill', 'alpha', 'coverage-map.md'),
      '# Coverage\n\n## Branches\n\n### 1. Core\n- [~] 1A. **First branch**\n- [ ] 1B. Second branch\n',
      'utf8'
    ),
    fs.writeFile(path.join(root, 'docs', 'plans', 'alpha-feature.md'), '# Plan\n', 'utf8'),
    fs.writeFile(
      path.join(root, '.scratch', 'alpha', 'issues', '02-second.md'),
      '# Second issue\nStatus: open\n',
      'utf8'
    ),
    fs.writeFile(
      path.join(root, '.scratch', 'alpha', 'issues', 'notes.md'),
      '# Supporting notes\n',
      'utf8'
    ),
    fs.writeFile(
      path.join(root, '.scratch', 'alpha', 'playwright-e2e.md'),
      '# Browser coverage\n',
      'utf8'
    )
  ]);
  index = artifactIndex(root);
  source = {
    observeNow: vi.fn(async () => index),
    current: vi.fn((_scope, revision?: string) => (
      !revision || revision === index.revision ? index : null
    ))
  };
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('FeatureService', () => {
  it('materializes one snapshot from the observed Artifact Index revision', async () => {
    const service = new FeatureService(source);

    const snapshot = await service.scan({
      cwd: root,
      runMode: 'windows',
      slug: 'alpha',
      observedRevision: index.revision
    });

    expect(source.current).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }), index.revision);
    expect(source.observeNow).not.toHaveBeenCalled();
    expect(snapshot.artifactRevision).toBe(index.revision);
    expect(snapshot.setup).toEqual({ hasAgentSkillsBlock: true, inFile: 'CLAUDE.md' });
    expect(snapshot.tracker.provider).toBe('local-markdown');
    expect(snapshot.coverage?.counts).toEqual({
      todo: 1,
      in_progress: 1,
      resolved: 0,
      deferred: 0
    });
    expect(snapshot.plans).toEqual([{
      relativePath: 'docs/plans/alpha-feature.md',
      name: 'alpha-feature'
    }]);
    expect(snapshot.issues.map((entry) => [entry.kind, entry.name, entry.status])).toEqual([
      ['issue', '02-second', 'open'],
      ['artifact', 'notes', null],
      ['artifact', 'playwright-e2e', null]
    ]);
  });

  it('serializes writes to one coverage map so concurrent toggles are preserved', async () => {
    const service = new FeatureService(source);

    await Promise.all([
      service.writeBranchStatus({
        cwd: root,
        runMode: 'windows',
        slug: 'alpha',
        branchId: '1A',
        status: 'resolved'
      }),
      service.writeBranchStatus({
        cwd: root,
        runMode: 'windows',
        slug: 'alpha',
        branchId: '1B',
        status: 'deferred'
      })
    ]);

    const written = await fs.readFile(
      path.join(root, 'docs', 'grill', 'alpha', 'coverage-map.md'),
      'utf8'
    );
    expect(written).toContain('- [x] 1A. **First branch**');
    expect(written).toContain('- [D] 1B. Second branch');
  });

  it('writes only issue files present in the current Artifact Index', async () => {
    const service = new FeatureService(source);
    const relativePath = '.scratch/alpha/issues/02-second.md';

    const issue = await service.writeIssueStatus({
      cwd: root,
      runMode: 'windows',
      relativePath,
      status: 'solved'
    });

    expect(issue.status).toBe('solved');
    expect(await fs.readFile(path.join(root, ...relativePath.split('/')), 'utf8'))
      .toContain('Status: solved');
    await expect(service.writeIssueStatus({
      cwd: root,
      runMode: 'windows',
      relativePath: '.scratch/alpha/issues/not-indexed.md',
      status: 'solved'
    })).rejects.toThrow('not part of the current Feature Artifact Index');
    await expect(service.writeIssueStatus({
      cwd: root,
      runMode: 'windows',
      relativePath: '../outside.md',
      status: 'solved'
    })).rejects.toThrow('indexed feature issue');
  });

  it('rejects unsafe feature slugs before observing the worktree', async () => {
    const service = new FeatureService(source);

    await expect(service.scan({
      cwd: root,
      runMode: 'windows',
      slug: '../escape'
    })).rejects.toThrow('one path segment');
    expect(source.current).not.toHaveBeenCalled();
    expect(source.observeNow).not.toHaveBeenCalled();
  });
});

function artifactIndex(cwd: string): FeatureArtifactIndex {
  const present = { state: 'present' as const, mtimeNs: '1', ctimeNs: '1', size: '1' };
  return {
    scope: { cwd, runMode: 'windows' },
    revision: 'revision-1',
    setup: { claude: present, agents: { state: 'missing' } },
    tracker: present,
    grill: [{ slug: 'alpha', coverage: present }],
    plans: [{
      relativePath: 'docs/plans/alpha-feature.md',
      name: 'alpha-feature',
      slugs: ['alpha']
    }],
    scratch: [{
      slug: 'alpha',
      issues: [
        {
          name: '02-second.md',
          relativePath: '.scratch/alpha/issues/02-second.md',
          stamp: present
        },
        {
          name: 'notes.md',
          relativePath: '.scratch/alpha/issues/notes.md',
          stamp: present
        }
      ],
      playwright: {
        relativePath: '.scratch/alpha/playwright-e2e.md',
        stamp: present
      }
    }],
    features: [{ slug: 'alpha', hasCoverage: true, hasIssues: true, hasPlans: true }],
    observedAt: 1
  };
}
