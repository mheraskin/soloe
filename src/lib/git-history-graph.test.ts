import { describe, expect, it } from 'vitest';
import { buildGitHistoryGraph, filterGitHistory } from './git-history-graph';

const root = {
  hash: 'a'.repeat(40),
  shortHash: 'aaaaaaa',
  author: 'Ada',
  authoredAt: '2026-01-01T00:00:00.000Z',
  subject: 'root',
  parents: [],
  refs: [{ name: 'main', kind: 'branch' as const, current: true }]
};

const feature = {
  hash: 'b'.repeat(40),
  shortHash: 'bbbbbbb',
  author: 'Bea',
  authoredAt: '2026-01-02T00:00:00.000Z',
  subject: 'feature work',
  parents: [root.hash],
  refs: [{ name: 'feature/search', kind: 'branch' as const, current: false }]
};

const head = {
  hash: 'c'.repeat(40),
  shortHash: 'ccccccc',
  author: 'Cal',
  authoredAt: '2026-01-03T00:00:00.000Z',
  subject: 'merge feature',
  parents: [root.hash, feature.hash],
  refs: []
};

describe('Git history graph', () => {
  it('keeps parent lanes connected through merge rows', () => {
    const rows = buildGitHistoryGraph([head, feature, root]);

    expect(rows[0]).toMatchObject({
      commit: head,
      nodeLane: 0
    });
    expect(rows[0]?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 0, to: 0 }),
        expect.objectContaining({ from: 0, to: 1 })
      ])
    );
    expect(rows[1]?.nodeLane).toBe(1);
    expect(rows[2]?.nodeLane).toBe(0);
  });

  it('searches branch names and commit metadata with one filter', () => {
    expect(filterGitHistory([head, feature, root], 'feature', 'all')).toEqual([
      feature,
      head
    ]);
    expect(filterGitHistory([head, feature, root], '', 'branches')).toEqual([
      feature,
      root
    ]);
    expect(filterGitHistory([head, feature, root], 'ada', 'commits')).toEqual([
      root
    ]);
  });
});
