import { describe, expect, it } from 'vitest';
import type { FileDiff } from '@shared/types/git.js';
import {
  estimateBlameBytes,
  estimateFileDiffBytes,
  ReviewPayloadCache,
  type ReviewPayloadLimits
} from './review-payload-cache';

const limits: ReviewPayloadLimits = {
  diff: { maxBytes: 100, maxEntries: 3 },
  blame: { maxBytes: 100, maxEntries: 2 }
};

describe('ReviewPayloadCache', () => {
  it('evicts the cold LRU payload while protecting resident files', () => {
    const cache = new ReviewPayloadCache(limits);
    cache.remember({ kind: 'diff', key: 'a', cwd: '/repo', pinKey: 'a.ts', bytes: 40 });
    cache.remember({ kind: 'diff', key: 'b', cwd: '/repo', pinKey: 'b.ts', bytes: 40 });
    cache.setResidents('/repo', ['a.ts']);

    expect(
      cache.remember({ kind: 'diff', key: 'c', cwd: '/repo', pinKey: 'c.ts', bytes: 40 })
    ).toEqual([{ kind: 'diff', key: 'b' }]);
    expect(cache.stats().diff).toEqual({ bytes: 80, entries: 2 });

    cache.setResidents('/repo', ['c.ts']);
    expect(
      cache.remember({ kind: 'diff', key: 'd', cwd: '/repo', pinKey: 'd.ts', bytes: 40 })
    ).toEqual([{ kind: 'diff', key: 'a' }]);
  });

  it('allows an oversized resident payload, then evicts it when released', () => {
    const cache = new ReviewPayloadCache(limits);
    cache.setResidents('/repo', ['huge.ts']);
    expect(
      cache.remember({ kind: 'diff', key: 'huge', cwd: '/repo', pinKey: 'huge.ts', bytes: 500 })
    ).toEqual([]);
    expect(cache.stats().diff).toEqual({ bytes: 500, entries: 1 });

    expect(cache.setResidents(null, [])).toEqual([{ kind: 'diff', key: 'huge' }]);
    expect(cache.stats().diff).toEqual({ bytes: 0, entries: 0 });
  });

  it('applies independent budgets and can forget one worktree', () => {
    const cache = new ReviewPayloadCache(limits);
    cache.remember({ kind: 'diff', key: 'a', cwd: '/a', pinKey: 'a.ts', bytes: 20 });
    cache.remember({ kind: 'blame', key: 'b', cwd: '/b', pinKey: 'b.ts', bytes: 20 });
    cache.forgetCwd('/a');

    expect(cache.stats()).toEqual({
      diff: { bytes: 0, entries: 0 },
      blame: { bytes: 20, entries: 1 }
    });
  });
});

describe('review payload size estimates', () => {
  it('scale with retained text and sparse blame slots', () => {
    const small = fileDiff('x');
    const large = fileDiff('x'.repeat(1000));
    expect(estimateFileDiffBytes(large)).toBeGreaterThan(estimateFileDiffBytes(small));
    expect(
      estimateBlameBytes([
        undefined,
        { lineNo: 1, sha: 'a'.repeat(40), summary: 'subject' }
      ])
    ).toBeGreaterThan(100);
  });
});

function fileDiff(text: string): FileDiff {
  return {
    path: 'file.ts',
    fromPath: null,
    kind: 'modified',
    binary: false,
    empty: false,
    hunks: [{
      header: '',
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [{ kind: 'context', oldLine: 1, newLine: 1, text }]
    }]
  };
}
