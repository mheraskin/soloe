import { describe, expect, it } from 'vitest';
import {
  branchHistoryHashes,
  buildGitHistoryGraph,
  commitRangeHashes,
  filterGitHistory,
  reviewRangeRefs,
  scopeGitHistory
} from './git-history-graph';

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

  it('scopes history to commits in a selected branch range', () => {
    expect(scopeGitHistory([head, feature, root], new Set([feature.hash, root.hash]))).toEqual([
      feature,
      root
    ]);
    expect(scopeGitHistory([head, feature, root], null)).toEqual([head, feature, root]);
  });

  it('browses commits reachable from a branch without turning the branch into a comparison base', () => {
    expect(branchHistoryHashes([head, feature, root], 'feature/search')).toEqual(
      new Set([feature.hash, root.hash])
    );
    expect(branchHistoryHashes([head, feature, root], 'missing')).toBeNull();
  });

  it('fills the commits between two selected endpoints', () => {
    expect(commitRangeHashes([head, feature, root], head.hash, root.hash)).toEqual(
      new Set([head.hash, feature.hash, root.hash])
    );
    expect(commitRangeHashes([head, feature, root], feature.hash, feature.hash)).toEqual(
      new Set([feature.hash])
    );
  });

  it('compares selected commits with the oldest parent unless a manual base is provided', () => {
    const selection = new Set([head.hash, feature.hash]);

    expect(reviewRangeRefs([head, feature, root], selection, '')).toEqual({
      base: `${feature.hash}~1`,
      head: head.hash,
      oldest: feature,
      newest: head
    });
    expect(reviewRangeRefs([head, feature, root], selection, 'main')).toEqual({
      base: 'main',
      head: head.hash,
      oldest: feature,
      newest: head
    });
  });
});
