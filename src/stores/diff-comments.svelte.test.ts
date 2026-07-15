// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '@shared/types/git.js';
import { worktreeScope } from '@shared/worktree-identity.js';

const state = vi.hoisted(() => ({
  modes: new Map<string, {
    kind: 'working-tree' | 'range';
    base?: string;
    head?: string;
    commits?: Array<{
      hash: string;
      shortHash: string;
      author: string;
      authoredAt: string;
      subject: string;
    }>;
  }>()
}));

vi.mock('./working-diff.svelte', () => ({
  workingDiff: {
    reviewModeFor: (scope: { cwd: string }) => state.modes.get(scope.cwd) ?? { kind: 'working-tree' },
    attributedCommitsFor: () => []
  }
}));

import { DiffCommentsStore, type DiffComment } from './diff-comments.svelte';

describe('DiffCommentsStore review sections', () => {
  beforeEach(() => {
    localStorage.clear();
    state.modes.clear();
  });

  it('keeps a WT comment in the WT section even while a range review is active', () => {
    const cwd = '/range-with-wt';
    const scope = worktreeScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    state.modes.set(cwd, {
      kind: 'range', base: 'base', head: 'head', commits: []
    });
    const store = new DiffCommentsStore();

    store.startSelection(scope, 'same.ts', 'new', 3, 'wt');
    const wt = store.endSelectionAndCreate();
    store.update(wt!.id, { text: 'WT note' });
    store.startSelection(scope, 'same.ts', 'new', 3, 'committed');
    const committed = store.endSelectionAndCreate();

    expect(wt).toMatchObject({ mode: 'wt' });
    expect(wt).not.toHaveProperty('reviewRange');
    expect(committed).toMatchObject({
      mode: 'range',
      reviewRange: { base: 'base', head: 'head', commits: [] }
    });
    expect(store.activeForFile(scope, 'same.ts', 'wt').map((comment) => comment.id)).toEqual([
      wt!.id
    ]);
    expect(
      store.activeForFile(scope, 'same.ts', 'committed').map((comment) => comment.id)
    ).toEqual([committed!.id]);
  });

  it('recomputes outdated state for one source without erasing the duplicate source', () => {
    const cwd = '/scoped-outdated';
    const scope = worktreeScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    state.modes.set(cwd, {
      kind: 'range', base: 'base', head: 'head', commits: []
    });
    const store = new DiffCommentsStore();
    const wt = anchoredComment('wt-comment', scope, 'wt', 'old WT');
    const committed = anchoredComment('range-comment', scope, 'range', 'old range');
    store.add(wt);
    store.add(committed);
    store.outdatedIds = new Set([wt.id]);

    store.recomputeOutdated(scope, 'same.ts', oneLineDiff('changed range'), 'committed');

    expect(store.outdatedIds).toEqual(new Set([wt.id, committed.id]));
    store.recomputeOutdated(scope, 'same.ts', oneLineDiff('old range'), 'committed');
    expect(store.outdatedIds).toEqual(new Set([wt.id]));
  });

  it('isolates comments for identical paths in different WSL distributions', () => {
    const cwd = '/same-path';
    const ubuntu = worktreeScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = worktreeScope(cwd, { runMode: 'wsl', wslDistro: 'Debian' });
    const store = new DiffCommentsStore();
    store.add(anchoredComment('ubuntu-comment', ubuntu, 'wt', 'ubuntu'));

    expect(store.forWorktree(ubuntu).map((comment) => comment.id)).toEqual(['ubuntu-comment']);
    expect(store.forWorktree(debian)).toEqual([]);
  });

  it('preserves scope isolation after persistence and re-keys trusted records', () => {
    const cwd = '/same-persisted-path';
    const ubuntu = worktreeScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = worktreeScope(cwd, { runMode: 'wsl', wslDistro: 'Debian' });
    const first = new DiffCommentsStore();
    first.add(anchoredComment('ubuntu-persisted', ubuntu, 'wt', 'ubuntu'));

    const saved = JSON.parse(localStorage.getItem('soloe.diffComments.v2')!);
    localStorage.setItem(
      'soloe.diffComments.v2',
      JSON.stringify({ 'deliberately-wrong-key': Object.values(saved).flat() })
    );
    const reloaded = new DiffCommentsStore();

    expect(reloaded.forWorktree(ubuntu).map((comment) => comment.id)).toEqual([
      'ubuntu-persisted'
    ]);
    expect(reloaded.forWorktree(debian)).toEqual([]);
  });

  it('ignores malformed scoped persistence instead of collapsing runtime identity', () => {
    localStorage.setItem(
      'soloe.diffComments.v2',
      JSON.stringify({ bad: [{ ...anchoredComment(
        'ambiguous',
        worktreeScope('/same-path', { runMode: 'wsl', wslDistro: 'Ubuntu' }),
        'wt',
        'text'
      ), scope: { cwd: '/same-path', runMode: 'wsl' } }] })
    );

    expect(new DiffCommentsStore().byId('ambiguous')).toBeNull();
  });

  it('keeps path-only comments legacy until the user assigns a Worktree', () => {
    const scope = worktreeScope('/legacy-path', { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const scoped = anchoredComment('legacy', scope, 'wt', 'old');
    const { scope: _scope, ...legacy } = scoped;
    localStorage.setItem(
      'soloe.diffComments.v1',
      JSON.stringify({ '/legacy-path::same.ts': [{ ...legacy, cwd: '/legacy-path' }] })
    );
    const store = new DiffCommentsStore();

    expect(store.forWorktree(scope)).toEqual([]);
    expect(store.legacyForWorktree(scope).map((comment) => comment.id)).toEqual(['legacy']);
    expect(store.adoptLegacy(scope)).toBe(1);
    expect(store.forWorktree(scope).map((comment) => comment.id)).toEqual(['legacy']);
    expect(store.legacyForWorktree(scope)).toEqual([]);
  });
});

function anchoredComment(
  id: string,
  scope: ReturnType<typeof worktreeScope>,
  mode: 'wt' | 'range',
  text: string
): DiffComment {
  return {
    id,
    scope,
    filePath: 'same.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    text: 'comment',
    createdAt: 1,
    updatedAt: 1,
    mode,
    ...(mode === 'range'
      ? { reviewRange: { base: 'base', head: 'head', commits: [] } }
      : {}),
    anchor: {
      text: [text],
      contextBefore: [],
      contextAfter: [],
      kinds: ['context']
    }
  };
}

function oneLineDiff(text: string): FileDiff {
  return {
    path: 'same.ts',
    fromPath: null,
    kind: 'modified',
    binary: false,
    empty: false,
    hunks: [{
      header: '@@ -1 +1 @@',
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [{ kind: 'context', oldLine: 1, newLine: 1, text }]
    }]
  };
}
