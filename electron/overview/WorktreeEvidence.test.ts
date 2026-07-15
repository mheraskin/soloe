import { describe, expect, it, vi } from 'vitest';
import type { WorktreeFacts } from '@shared/types/overview.js';
import { WorktreeEvidence } from './WorktreeEvidence.js';

const facts: WorktreeFacts = {
  cwd: '/repo', branch: 'main', head: 'a'.repeat(40), baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  commitsAhead: 0, commitsBehind: 0, commitsAheadShas: [], pushedAhead: true,
  mergedIntoBase: true, dirtyFiles: [], dirtyHash: 'clean', workingDiff: '',
  evidenceFingerprint: 'evidence', completeness: 'complete', diagnostics: [],
  recentCommits: []
};

describe('WorktreeEvidence', () => {
  it('coalesces concurrent acquisition and reuses one inspected generation once', async () => {
    const listScopedSessions = vi.fn(async () => []);
    const collect = vi.fn(async () => facts);
    const evidence = new WorktreeEvidence({
      reader: { listScopedSessions, listAllSessions: vi.fn(async () => []) },
      facts: { collect },
      reuseMs: 5_000
    });
    const input = { worktreeCwd: '/repo', runMode: 'windows' as const, sessions: [] };

    const [first, joined] = await Promise.all([
      evidence.inspect(input),
      evidence.materialize(input)
    ]);
    expect(joined).toBe(first);
    await expect(evidence.consume(input)).resolves.toBe(first);
    await evidence.consume(input);

    expect(listScopedSessions).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('does not reuse evidence across different session scopes', async () => {
    const collect = vi.fn(async () => facts);
    const evidence = new WorktreeEvidence({
      reader: {
        listScopedSessions: vi.fn(async () => []),
        listAllSessions: vi.fn(async () => [])
      },
      facts: { collect }
    });

    await evidence.inspect({
      worktreeCwd: '/repo',
      sessions: [{ transcriptPath: '/one.jsonl', name: 'One' }]
    });
    await evidence.consume({
      worktreeCwd: '/repo',
      sessions: [{ transcriptPath: '/two.jsonl', name: 'Two' }]
    });

    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('preserves tab order, names, and full transcript watermarks', async () => {
    const refs = [
      {
        provider: 'codex' as const,
        sessionFile: '/two.jsonl',
        sessionId: 'two',
        displayName: 'Second tab',
        watermark: { mtimeMs: 20, size: 200, lastRecordKey: 'two:4' }
      },
      {
        provider: 'claude_code' as const,
        sessionFile: '/one.jsonl',
        sessionId: 'one',
        displayName: 'First tab',
        watermark: { mtimeMs: 10, size: 100, lastRecordKey: 'one:2' }
      }
    ];
    const evidence = new WorktreeEvidence({
      reader: {
        listScopedSessions: vi.fn(async () => refs),
        listAllSessions: vi.fn(async () => refs)
      },
      facts: { collect: vi.fn(async () => facts) }
    });

    const generation = await evidence.materialize({
      worktreeCwd: '/repo',
      sessions: [
        { transcriptPath: '/two.jsonl', name: 'Second tab' },
        { transcriptPath: '/one.jsonl', name: 'First tab' }
      ]
    });

    expect(generation.watermark.perSession).toEqual([
      {
        sessionFile: '/two.jsonl', displayName: 'Second tab',
        mtimeMs: 20, size: 200, lastRecordKey: 'two:4'
      },
      {
        sessionFile: '/one.jsonl', displayName: 'First tab',
        mtimeMs: 10, size: 100, lastRecordKey: 'one:2'
      }
    ]);
  });
});
