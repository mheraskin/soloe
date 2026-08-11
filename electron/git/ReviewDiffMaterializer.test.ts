import { describe, expect, it } from 'vitest';
import { materializeReviewDiffs } from './ReviewDiffMaterializer.js';

describe('materializeReviewDiffs', () => {
  it('maps a repository patch to requested files including paths with spaces', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/docs/my file.md b/docs/my file.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/docs/my file.md',
      '@@ -0,0 +1 @@',
      '+hello',
      ''
    ].join('\n');

    const result = materializeReviewDiffs(patch, [
      { path: 'src/a.ts' },
      { path: 'docs/my file.md' }
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ path: 'src/a.ts', kind: 'modified', empty: false });
    expect(result[1]).toMatchObject({ path: 'docs/my file.md', kind: 'added', empty: false });
  });

  it('preserves rename metadata and binary-only blocks', () => {
    const patch = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
      'diff --git a/image.png b/image.png',
      'Binary files a/image.png and b/image.png differ',
      ''
    ].join('\n');

    const result = materializeReviewDiffs(patch, [
      { path: 'new.ts', fromPath: 'old.ts' },
      { path: 'image.png' }
    ]);

    expect(result[0]).toMatchObject({ path: 'new.ts', fromPath: 'old.ts', kind: 'renamed' });
    expect(result[1]).toMatchObject({ path: 'image.png', binary: true, empty: true });
  });

  it('omits targets absent from the patch so callers can fall back lazily', () => {
    expect(materializeReviewDiffs('', [{ path: 'untracked.txt' }])).toEqual([]);
  });
});
