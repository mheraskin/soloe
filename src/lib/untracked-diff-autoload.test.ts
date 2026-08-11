import { describe, expect, it } from 'vitest';
import type { WorkingChange } from '@shared/types/git.js';
import {
  shouldAutoLoadUntrackedDiff,
  UNTRACKED_DIFF_AUTOLOAD_EXCLUDED_DIRECTORIES,
  UNTRACKED_DIFF_AUTOLOAD_MAX_LINES
} from './untracked-diff-autoload';

function untracked(path: string, overrides: Partial<WorkingChange> = {}): WorkingChange {
  return {
    path,
    fromPath: null,
    kind: 'untracked',
    staged: false,
    insertions: 10,
    deletions: 0,
    binary: false,
    ...overrides
  };
}

describe('untracked diff autoload policy', () => {
  it('autoloads ordinary created source and documentation files', () => {
    expect(shouldAutoLoadUntrackedDiff(untracked('src/new-feature.ts'))).toBe(true);
    expect(shouldAutoLoadUntrackedDiff(untracked('docs/new-plan.md'))).toBe(true);
  });

  it('keeps dependency, cache, and generated-output trees manual-load only', () => {
    expect(UNTRACKED_DIFF_AUTOLOAD_EXCLUDED_DIRECTORIES).toContain('node_modules');
    expect(shouldAutoLoadUntrackedDiff(untracked('web/node_modules/pkg/index.js'))).toBe(false);
    expect(shouldAutoLoadUntrackedDiff(untracked('web\\NODE_MODULES\\pkg\\index.js'))).toBe(false);
    expect(shouldAutoLoadUntrackedDiff(untracked('packages/app/.next/server.js'))).toBe(false);
    expect(shouldAutoLoadUntrackedDiff(untracked('crates/app/target/debug/output.txt'))).toBe(false);
  });

  it('keeps oversized, binary, and generated text files manual-load only', () => {
    expect(
      shouldAutoLoadUntrackedDiff(
        untracked('fixtures/huge.txt', {
          insertions: UNTRACKED_DIFF_AUTOLOAD_MAX_LINES + 1
        })
      )
    ).toBe(false);
    expect(shouldAutoLoadUntrackedDiff(untracked('assets/image.png', { binary: true }))).toBe(false);
    expect(shouldAutoLoadUntrackedDiff(untracked('public/app.js.map'))).toBe(false);
  });
});
