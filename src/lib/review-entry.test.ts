import { describe, expect, it } from 'vitest';
import {
  findReviewEntry,
  reviewEntryId,
  reviewEntryIdFrom,
  reviewEntryPath,
  reviewEntrySectionFromId
} from './review-entry';

describe('review entry identity', () => {
  it('distinguishes the same path in WT and committed review sections', () => {
    const range = { kind: 'range' as const, base: 'base', head: 'head' };
    const wt = reviewEntryIdFrom('src/same.ts', 'wt');
    const committed = reviewEntryIdFrom('src/same.ts', 'committed', range);
    expect(wt).not.toBe(committed);
    expect(reviewEntryPath(wt)).toBe('src/same.ts');
    expect(reviewEntryPath(committed)).toBe('src/same.ts');
    expect(reviewEntrySectionFromId(wt)).toBe('wt');
    expect(reviewEntrySectionFromId(committed)).toBe('committed');
  });

  it('finds the exact logical entry rather than the first matching path', () => {
    const range = { kind: 'range' as const, base: 'base', head: 'head' };
    const changes = [
      { path: 'same.ts', section: 'wt' as const },
      { path: 'same.ts', section: 'committed' as const }
    ];
    expect(findReviewEntry(changes, reviewEntryId(changes[1]!, range), range)?.section).toBe('committed');
  });

  it('is stable across mutable display metadata but scoped to the reviewed range', () => {
    const original = {
      path: 'src/stable.ts',
      section: 'committed' as const,
      staged: false,
      insertions: 1
    };
    const refreshed = { ...original, staged: true, insertions: 9 };
    const firstRange = { kind: 'range' as const, base: 'a', head: 'b' };
    const nextRange = { kind: 'range' as const, base: 'a', head: 'c' };

    expect(reviewEntryId(original, firstRange)).toBe(reviewEntryId(refreshed, firstRange));
    expect(reviewEntryId(original, firstRange)).not.toBe(reviewEntryId(original, nextRange));
    expect(reviewEntryIdFrom(original.path, 'wt', firstRange)).toBe(
      reviewEntryIdFrom(original.path, 'wt', nextRange)
    );
  });
});
