import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FileDiff,
  RangeChangesResult,
  ReviewDiffsRequest,
  WorkingChangesResult
} from '@shared/types/git.js';

const mocks = vi.hoisted(() => ({
  workingChanges: vi.fn(),
  rangeChanges: vi.fn(),
  reviewDiffs: vi.fn(async (_request: ReviewDiffsRequest): Promise<FileDiff[]> => []),
  fileDiff: vi.fn(),
  fileLines: vi.fn(),
  fileBlame: vi.fn(),
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  discardFiles: vi.fn(),
  onChange: vi.fn(() => () => undefined),
  onTick: vi.fn(() => () => undefined)
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    git: {
      workingChanges: mocks.workingChanges,
      rangeChanges: mocks.rangeChanges,
      reviewDiffs: mocks.reviewDiffs,
      fileDiff: mocks.fileDiff,
      fileLines: mocks.fileLines,
      fileBlame: mocks.fileBlame,
      stageFiles: mocks.stageFiles,
      unstageFiles: mocks.unstageFiles,
      discardFiles: mocks.discardFiles,
      onChange: mocks.onChange
    }
  }
}));

vi.mock('./git.svelte', () => ({
  git: { onTick: mocks.onTick }
}));

import { createReviewScope, WorkingDiffStore } from './working-diff.svelte';
import {
  reviewEntryId,
  reviewEntrySectionFromId
} from '../lib/review-entry';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function changesResult(path: string): WorkingChangesResult {
  return {
    repoPath: '/home/me/repo',
    isRepo: true,
    changes: [{
      path,
      fromPath: null,
      kind: 'modified',
      staged: false,
      insertions: 1,
      deletions: 1,
      binary: false
    }]
  };
}

describe('WorkingDiffStore review freshness', () => {
  beforeEach(() => {
    mocks.workingChanges.mockReset();
    mocks.rangeChanges.mockReset();
    mocks.reviewDiffs.mockReset();
    mocks.reviewDiffs.mockResolvedValue([]);
    mocks.fileDiff.mockReset();
    mocks.fileLines.mockReset();
    mocks.fileBlame.mockReset();
    mocks.stageFiles.mockReset();
    mocks.unstageFiles.mockReset();
    mocks.discardFiles.mockReset();
    mocks.onChange.mockClear();
    mocks.onTick.mockClear();
  });

  it('does not reuse or apply a working-tree request after switching to a range', async () => {
    const oldResponse = deferred<WorkingChangesResult>();
    const rangeResponse = deferred<RangeChangesResult>();
    mocks.workingChanges.mockReturnValueOnce(oldResponse.promise);
    mocks.rangeChanges.mockReturnValueOnce(rangeResponse.promise);
    const store = new WorkingDiffStore();

    const oldLoad = store.loadChanges('/repo');
    store.setReviewMode('/repo', {
      kind: 'range',
      base: 'base',
      head: 'head',
      commits: [],
      includeWorkingTree: false,
      chipFilter: null
    });
    const rangeLoad = store.loadChanges('/repo');

    expect(mocks.workingChanges).toHaveBeenCalledTimes(1);
    expect(mocks.rangeChanges).toHaveBeenCalledTimes(1);
    rangeResponse.resolve({
      base: 'base',
      head: 'head',
      changes: [{
        path: 'range.ts',
        fromPath: null,
        kind: 'modified',
        insertions: 1,
        deletions: 0,
        binary: false,
        commitsTouching: ['head']
      }]
    });
    await rangeLoad;

    oldResponse.resolve({
      repoPath: '/repo',
      isRepo: true,
      changes: [{
        path: 'stale.ts',
        fromPath: null,
        kind: 'modified',
        staged: false,
        insertions: 1,
        deletions: 1,
        binary: false
      }]
    });
    await oldLoad;

    expect(store.changesFor('/repo').result?.changes).toEqual([
      expect.objectContaining({ path: 'range.ts', section: 'committed' })
    ]);
  });

  it('coalesces callers that share the same immutable review identity', async () => {
    const response = deferred<WorkingChangesResult>();
    mocks.workingChanges.mockReturnValueOnce(response.promise);
    const store = new WorkingDiffStore();

    const first = store.loadChanges('/repo');
    const second = store.loadChanges('/repo');
    expect(mocks.workingChanges).toHaveBeenCalledTimes(1);

    response.resolve({ repoPath: '/repo', isRepo: true, changes: [] });
    await Promise.all([first, second]);
    expect(store.changesFor('/repo').loading).toBe(false);
  });

  it('isolates cached diffs and destructive mutations across WSL distributions', async () => {
    mocks.workingChanges.mockImplementation(async (request: { wslDistro?: string }) => {
      const distro = request.wslDistro ?? 'native';
      return {
        repoPath: '/home/me/repo',
        isRepo: true,
        changes: [{
          path: `${distro}.ts`,
          fromPath: null,
          kind: 'modified' as const,
          staged: false,
          insertions: 1,
          deletions: 1,
          binary: false
        }]
      };
    });
    mocks.fileDiff.mockImplementation(async (request: { path: string }) => fileDiff(request.path));
    mocks.discardFiles.mockResolvedValue(true);
    const store = new WorkingDiffStore();
    const cwd = '/home/me/repo';
    const ubuntu = createReviewScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = createReviewScope(cwd, { runMode: 'wsl', wslDistro: 'Debian' });

    await store.loadChanges(ubuntu);
    await store.loadDiff(ubuntu, 'Ubuntu.ts');
    expect(store.changesFor(ubuntu).result?.changes[0]?.path).toBe('Ubuntu.ts');
    expect(store.diffEntryFor(ubuntu, 'Ubuntu.ts').diff?.path).toBe('Ubuntu.ts');

    expect(store.changesFor(debian).result).toBeNull();
    expect(store.diffEntryFor(debian, 'Ubuntu.ts').diff).toBeNull();
    await store.loadChanges(debian);
    await store.loadDiff(debian, 'Debian.ts');
    const debianChange = store.changesFor(debian).result!.changes[0]!;
    await store.discardEntries(
      debian,
      [reviewEntryId(debianChange, { kind: 'working-tree' })]
    );

    expect(store.changesFor(debian).result?.changes[0]?.path).toBe('Debian.ts');
    expect(mocks.discardFiles).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
      wslDistro: 'Debian',
      files: [expect.objectContaining({ path: 'Debian.ts' })]
    }));

    expect(store.changesFor(ubuntu).result?.changes[0]?.path).toBe('Ubuntu.ts');
    expect(store.diffEntryFor(ubuntu, 'Ubuntu.ts').diff?.path).toBe('Ubuntu.ts');
  });

  it('keeps same-path distro responses isolated when they resolve in reverse order', async () => {
    const ubuntuResponse = deferred<WorkingChangesResult>();
    const debianResponse = deferred<WorkingChangesResult>();
    mocks.workingChanges.mockImplementation((request: { wslDistro?: string }) =>
      request.wslDistro === 'Ubuntu' ? ubuntuResponse.promise : debianResponse.promise
    );
    const store = new WorkingDiffStore();
    const cwd = '/home/me/repo';
    const ubuntu = createReviewScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = createReviewScope(cwd, { runMode: 'wsl', wslDistro: 'Debian' });

    const ubuntuLoad = store.loadChanges(ubuntu);
    const debianLoad = store.loadChanges(debian);
    debianResponse.resolve(changesResult('debian.ts'));
    await debianLoad;
    ubuntuResponse.resolve(changesResult('ubuntu.ts'));
    await ubuntuLoad;

    expect(store.changesFor(ubuntu).result?.changes[0]?.path).toBe('ubuntu.ts');
    expect(store.changesFor(debian).result?.changes[0]?.path).toBe('debian.ts');
  });

  it('applies the Git polling snapshot without rescanning the working tree', async () => {
    mocks.workingChanges.mockResolvedValueOnce({ repoPath: '/repo', isRepo: true, changes: [] });
    const store = new WorkingDiffStore();
    store.attachListeners();
    const release = store.acquireReviewDemand(createReviewScope('/repo'));
    await vi.waitFor(() => expect(store.changesFor('/repo').loading).toBe(false));
    mocks.workingChanges.mockClear();
    const tickCalls = mocks.onTick.mock.calls as unknown as Array<[
      (cwd: string, changes: WorkingChangesResult, cause: { kind: 'poll' }) => void
    ]>;
    const tick = tickCalls.at(-1)![0];

    tick('/repo', {
      repoPath: '/repo',
      isRepo: true,
      changes: [{
        path: 'observed.ts',
        fromPath: null,
        kind: 'modified',
        staged: false,
        insertions: 2,
        deletions: 1,
        binary: false
      }]
    }, { kind: 'poll' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.workingChanges).not.toHaveBeenCalled();
    expect(store.changesFor('/repo').result?.changes).toEqual([
      expect.objectContaining({ path: 'observed.ts', section: 'wt' })
    ]);
    release();
    store.detach();
  });

  it('preserves review state identity for an unchanged Git observation', async () => {
    const scope = createReviewScope('/repo');
    const observed = changesResult('steady.ts');
    mocks.workingChanges.mockResolvedValueOnce(observed);
    const store = new WorkingDiffStore();
    store.attachListeners();
    const release = store.acquireReviewDemand(scope);
    await vi.waitFor(() => expect(store.changesFor(scope).loading).toBe(false));

    const beforeEntry = store.changesFor(scope);
    const beforeResult = beforeEntry.result;
    const tick = (mocks.onTick.mock.calls as unknown as Array<[
      (
        cwd: string,
        changes: WorkingChangesResult,
        cause: { kind: 'poll' },
        context: Record<string, never>
      ) => void
    ]>).at(-1)![0];

    tick('/repo', changesResult('steady.ts'), { kind: 'poll' }, {});

    expect(store.changesFor(scope)).toBe(beforeEntry);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.changesFor(scope)).toBe(beforeEntry);
    expect(store.changesFor(scope).result).toBe(beforeResult);

    release();
    store.detach();
  });

  it('invalidates cached file content when a filesystem cause keeps the same summary', async () => {
    const observed: WorkingChangesResult = {
      repoPath: '/repo',
      isRepo: true,
      changes: [{
        path: 'same-summary.ts',
        fromPath: null,
        kind: 'modified',
        staged: false,
        insertions: 1,
        deletions: 1,
        binary: false
      }]
    };
    mocks.workingChanges.mockResolvedValue(observed);
    mocks.fileDiff.mockResolvedValueOnce(fileDiff('same-summary.ts'));
    const store = new WorkingDiffStore();
    await store.loadChanges('/repo');
    await store.loadDiff('/repo', 'same-summary.ts');
    expect(store.diffEntryFor('/repo', 'same-summary.ts').diff).not.toBeNull();

    store.attachListeners();
    const release = store.acquireReviewDemand(createReviewScope('/repo'));
    await vi.waitFor(() => expect(store.changesFor('/repo').loading).toBe(false));
    mocks.workingChanges.mockClear();
    const tickCalls = mocks.onTick.mock.calls as unknown as Array<[
      (
        cwd: string,
        changes: WorkingChangesResult,
        cause: { kind: 'filesystem'; occurredAt: number }
      ) => void
    ]>;
    tickCalls.at(-1)![0]('/repo', observed, {
      kind: 'filesystem',
      occurredAt: Date.now() + 1
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.workingChanges).not.toHaveBeenCalled();
    expect(store.diffEntryFor('/repo', 'same-summary.ts').diff).toBeNull();
    release();
    store.detach();
  });

  it('uses visible Review Refresh Intent instead of cache presence for Git ticks', async () => {
    const scope = createReviewScope('/repo');
    const observed = changesResult('active.ts');
    mocks.workingChanges.mockResolvedValue(observed);
    mocks.rangeChanges.mockResolvedValue({ base: 'base', head: 'head', changes: [] });
    const store = new WorkingDiffStore();
    store.setReviewMode(scope, {
      kind: 'range',
      base: 'base',
      head: 'head',
      commits: [],
      includeWorkingTree: true,
      chipFilter: null
    });
    store.attachListeners();
    const tick = (mocks.onTick.mock.calls as unknown as Array<[
      (
        cwd: string,
        changes: WorkingChangesResult,
        cause: { kind: 'poll' },
        context: Record<string, never>
      ) => void
    ]>).at(-1)![0];

    const releaseDiff = store.acquireReviewDemand(scope);
    const releaseFiles = store.acquireReviewDemand(scope);
    await vi.waitFor(() => expect(mocks.rangeChanges).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.changesFor(scope).loading).toBe(false));

    releaseDiff();
    tick('/repo', observed, { kind: 'poll' }, {});
    await vi.waitFor(() => expect(store.changesFor(scope).loading).toBe(false));
    expect(mocks.rangeChanges).toHaveBeenCalledTimes(1);

    releaseFiles();
    tick('/repo', observed, { kind: 'poll' }, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.rangeChanges).toHaveBeenCalledTimes(1);

    const releaseAgain = store.acquireReviewDemand(scope);
    await vi.waitFor(() => expect(mocks.rangeChanges).toHaveBeenCalledTimes(2));
    releaseAgain();
    store.detach();
  });

  it('bounds review materialization to the requested resident window', async () => {
    const changes = Array.from({ length: 40 }, (_, index) => ({
      path: `file-${index}.ts`,
      fromPath: null,
      kind: 'modified' as const,
      staged: false,
      insertions: 1,
      deletions: 1,
      binary: false
    }));
    mocks.workingChanges.mockResolvedValueOnce({ repoPath: '/repo', isRepo: true, changes });
    const store = new WorkingDiffStore();
    await store.loadChanges('/repo');

    await store.prefetchDiffs('/repo', changes.slice(5, 35).map((change) => change.path));

    expect(mocks.reviewDiffs).toHaveBeenCalledTimes(1);
    expect(mocks.reviewDiffs.mock.calls[0]?.[0].files).toHaveLength(16);
    expect(mocks.reviewDiffs.mock.calls[0]?.[0].files[0]?.path).toBe('file-5.ts');
    expect(mocks.reviewDiffs.mock.calls[0]?.[0].files[15]?.path).toBe('file-20.ts');
  });

  it('automatically loads ordinary untracked files but leaves generated and oversized files lazy', async () => {
    const changes = [
      {
        path: 'frontend/order-ahead/src/app.ts',
        fromPath: null,
        kind: 'untracked' as const,
        staged: false,
        insertions: 24,
        deletions: 0,
        binary: false
      },
      {
        path: 'frontend/order-ahead/node_modules/pkg/index.js',
        fromPath: null,
        kind: 'untracked' as const,
        staged: false,
        insertions: 12,
        deletions: 0,
        binary: false
      },
      {
        path: 'frontend/order-ahead/dist/bundle.js',
        fromPath: null,
        kind: 'untracked' as const,
        staged: false,
        insertions: 300,
        deletions: 0,
        binary: false
      },
      {
        path: 'fixtures/huge-generated.txt',
        fromPath: null,
        kind: 'untracked' as const,
        staged: false,
        insertions: 5_001,
        deletions: 0,
        binary: false
      },
      {
        path: 'assets/new-image.png',
        fromPath: null,
        kind: 'untracked' as const,
        staged: false,
        insertions: 0,
        deletions: 0,
        binary: true
      }
    ];
    mocks.workingChanges.mockResolvedValueOnce({ repoPath: '/repo', isRepo: true, changes });
    mocks.fileDiff.mockImplementation(async (request: { path: string }) =>
      fileDiff(request.path)
    );
    const store = new WorkingDiffStore();
    await store.loadChanges('/repo');

    await store.prefetchDiffs('/repo', changes.map((change) => change.path));

    expect(mocks.fileDiff).toHaveBeenCalledTimes(1);
    expect(mocks.fileDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'frontend/order-ahead/src/app.ts',
        untracked: true
      })
    );
    expect(store.diffEntryFor('/repo', 'frontend/order-ahead/src/app.ts').diff).not.toBeNull();
    expect(store.diffEntryFor('/repo', 'frontend/order-ahead/node_modules/pkg/index.js').diff)
      .toBeNull();
    expect(store.diffEntryFor('/repo', 'frontend/order-ahead/dist/bundle.js').diff).toBeNull();
    expect(store.diffEntryFor('/repo', 'fixtures/huge-generated.txt').diff).toBeNull();
    expect(store.diffEntryFor('/repo', 'assets/new-image.png').diff).toBeNull();
  });

  it('limits concurrent automatic loads for resident untracked files', async () => {
    const changes = Array.from({ length: 5 }, (_, index) => ({
      path: `src/new-${index}.ts`,
      fromPath: null,
      kind: 'untracked' as const,
      staged: false,
      insertions: 10,
      deletions: 0,
      binary: false
    }));
    mocks.workingChanges.mockResolvedValueOnce({ repoPath: '/repo', isRepo: true, changes });
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    mocks.fileDiff.mockImplementation((request: { path: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<FileDiff>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve(fileDiff(request.path));
        });
      });
    });
    const store = new WorkingDiffStore();
    await store.loadChanges('/repo');

    const loading = Promise.all([
      store.prefetchDiffs('/repo', changes.slice(0, 3).map((change) => change.path)),
      store.prefetchDiffs('/repo', changes.slice(3).map((change) => change.path))
    ]);
    await vi.waitFor(() => expect(mocks.fileDiff).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(2);

    releases.splice(0, 2).forEach((release) => release());
    await vi.waitFor(() => expect(mocks.fileDiff).toHaveBeenCalledTimes(4));
    releases.splice(0, 2).forEach((release) => release());
    await vi.waitFor(() => expect(mocks.fileDiff).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach((release) => release());
    await loading;

    expect(maxActive).toBe(2);
  });

  it('bounds accumulated diff payloads while scrolling through a long review', async () => {
    const changes = Array.from({ length: 80 }, (_, index) => ({
      path: `file-${index}.ts`,
      fromPath: null,
      kind: 'modified' as const,
      staged: false,
      insertions: 1,
      deletions: 1,
      binary: false
    }));
    mocks.workingChanges.mockResolvedValueOnce({ repoPath: '/repo', isRepo: true, changes });
    mocks.reviewDiffs.mockImplementation(async (request: ReviewDiffsRequest) =>
      request.files.map(({ path }) => fileDiff(path))
    );
    const store = new WorkingDiffStore();
    await store.loadChanges('/repo');

    for (let offset = 0; offset < changes.length; offset += 16) {
      await store.prefetchDiffs(
        '/repo',
        changes.slice(offset, offset + 16).map((change) => change.path)
      );
    }

    expect(store.reviewPayloadStats().diff.entries).toBe(64);
    expect(store.diffEntryFor('/repo', 'file-0.ts').diff).toBeNull();
    expect(store.diffEntryFor('/repo', 'file-79.ts').diff?.path).toBe('file-79.ts');
  });

  it('does not let invalidated late requests resurrect diff, gap, or blame payloads', async () => {
    mocks.workingChanges.mockResolvedValueOnce({
      repoPath: '/repo',
      isRepo: true,
      changes: [{
        path: 'late.ts',
        fromPath: null,
        kind: 'modified',
        staged: false,
        insertions: 1,
        deletions: 1,
        binary: false
      }]
    });
    const diffResponse = deferred<FileDiff>();
    const linesResponse = deferred<{ lines: string[]; totalLines: number }>();
    const blameResponse = deferred<{
      lines: Array<{ lineNo: number; sha: string; summary: string }>;
    }>();
    mocks.fileDiff.mockReturnValueOnce(diffResponse.promise);
    mocks.fileLines.mockReturnValueOnce(linesResponse.promise);
    mocks.fileBlame.mockReturnValueOnce(blameResponse.promise);
    const store = new WorkingDiffStore();
    await store.loadChanges('/repo');

    const diffLoad = store.loadDiff('/repo', 'late.ts');
    const linesLoad = store.loadFileLines('/repo', 'late.ts', 2, 3);
    const blameLoad = store.loadBlame('/repo', 'late.ts', 'head');
    store.invalidate('/repo');
    diffResponse.resolve(fileDiff('late.ts'));
    linesResponse.resolve({ lines: ['two', 'three'], totalLines: 3 });
    blameResponse.resolve({
      lines: [{ lineNo: 1, sha: 'a'.repeat(40), summary: 'old request' }]
    });
    await Promise.all([diffLoad, linesLoad, blameLoad]);

    expect(store.diffEntryFor('/repo', 'late.ts').diff).toBeNull();
    expect(store.fileLinesEntry('/repo', 'late.ts', 2, 3).lines).toBeNull();
    expect(store.blameEntry('/repo', 'late.ts', 'head').byLine).toEqual([]);
    expect(store.reviewPayloadStats()).toEqual({
      diff: { bytes: 0, entries: 0 },
      blame: { bytes: 0, entries: 0 }
    });
  });

  it('dedupes overlapping batches and lets direct loads join their member request', async () => {
    const changes = Array.from({ length: 3 }, (_, index) => ({
      path: `join-${index}.ts`,
      fromPath: null,
      kind: 'modified' as const,
      staged: false,
      insertions: 1,
      deletions: 1,
      binary: false
    }));
    mocks.workingChanges.mockResolvedValueOnce({ repoPath: '/repo', isRepo: true, changes });
    const batch = deferred<FileDiff[]>();
    mocks.reviewDiffs.mockReturnValueOnce(batch.promise);
    const store = new WorkingDiffStore();
    await store.loadChanges('/repo');

    const first = store.prefetchDiffs('/repo', changes.map((change) => change.path));
    const second = store.prefetchDiffs('/repo', changes.map((change) => change.path));
    const direct = store.loadDiff('/repo', 'join-1.ts');
    expect(mocks.reviewDiffs).toHaveBeenCalledTimes(1);
    expect(mocks.fileDiff).not.toHaveBeenCalled();

    batch.resolve(changes.map((change) => fileDiff(change.path)));
    await Promise.all([first, second]);
    await expect(direct).resolves.toEqual(expect.objectContaining({ path: 'join-1.ts' }));
    expect(store.reviewPayloadStats().diff.entries).toBe(3);
  });

  it('does not cancel another worktree batch when one worktree invalidates', async () => {
    mocks.workingChanges
      .mockResolvedValueOnce({
        repoPath: '/a',
        isRepo: true,
        changes: [{
          path: 'a.ts', fromPath: null, kind: 'modified', staged: false,
          insertions: 1, deletions: 1, binary: false
        }]
      })
      .mockResolvedValueOnce({
        repoPath: '/b',
        isRepo: true,
        changes: [{
          path: 'b.ts', fromPath: null, kind: 'modified', staged: false,
          insertions: 1, deletions: 1, binary: false
        }]
      });
    const batch = deferred<FileDiff[]>();
    mocks.reviewDiffs.mockReturnValueOnce(batch.promise);
    const store = new WorkingDiffStore();
    await store.loadChanges('/a');
    await store.loadChanges('/b');

    const loadingA = store.prefetchDiffs('/a', ['a.ts']);
    store.invalidate('/b');
    batch.resolve([fileDiff('a.ts')]);
    await loadingA;

    expect(store.diffEntryFor('/a', 'a.ts').diff?.path).toBe('a.ts');
  });

  it('caches a successful empty blame result', async () => {
    mocks.fileBlame.mockResolvedValue({ lines: [] });
    const store = new WorkingDiffStore();

    const first = await store.loadBlame('/repo', 'empty.ts', 'head');
    const second = await store.loadBlame('/repo', 'empty.ts', 'head');

    expect(first.byLine).toEqual([]);
    expect(second.byLine).toEqual([]);
    expect(mocks.fileBlame).toHaveBeenCalledTimes(1);
    expect(store.reviewPayloadStats().blame.entries).toBe(1);
  });

  it('keeps duplicate WT and committed paths independently selectable and cached', async () => {
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    mocks.workingChanges.mockResolvedValueOnce({
      repoPath: '/repo',
      isRepo: true,
      changes: [{
        path: 'same.ts', fromPath: null, kind: 'modified', staged: false,
        insertions: 1, deletions: 1, binary: false
      }]
    });
    mocks.rangeChanges.mockResolvedValueOnce({
      base,
      head,
      changes: [{
        path: 'same.ts', fromPath: null, kind: 'modified', insertions: 2,
        deletions: 0, binary: false, commitsTouching: [head]
      }]
    });
    mocks.fileDiff
      .mockResolvedValueOnce(fileDiff('same.ts'))
      .mockResolvedValueOnce(fileDiff('same.ts'));
    const store = new WorkingDiffStore();
    store.setReviewMode('/repo', {
      kind: 'range', base, head, commits: [], includeWorkingTree: true, chipFilter: null
    });
    await store.loadChanges('/repo');

    const changes = store.changesFor('/repo').result!.changes;
    expect(changes.map((change) => change.section)).toEqual(['wt', 'committed']);

    store.setSelected('/repo', 'same.ts', 'committed');
    expect(reviewEntrySectionFromId(store.selectedReviewEntry('/repo')!)).toBe('committed');
    await store.loadDiff('/repo', 'same.ts', 'committed');
    expect(mocks.fileDiff).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: '/repo', path: 'same.ts', base, head })
    );

    store.setSelected('/repo', 'same.ts', 'wt');
    expect(reviewEntrySectionFromId(store.selectedReviewEntry('/repo')!)).toBe('wt');
    await store.loadDiff('/repo', 'same.ts', 'wt');
    expect(mocks.fileDiff).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ base: expect.anything(), head: expect.anything() })
    );
    expect(store.diffEntryFor('/repo', 'same.ts', base, head).diff).not.toBeNull();
    expect(store.diffEntryFor('/repo', 'same.ts', null, null).diff).not.toBeNull();
  });

  it('prefetches duplicate paths from their exact review sources', async () => {
    const base = 'c'.repeat(40);
    const head = 'd'.repeat(40);
    mocks.workingChanges.mockResolvedValueOnce({
      repoPath: '/repo', isRepo: true,
      changes: [{
        path: 'same.ts', fromPath: null, kind: 'modified', staged: false,
        insertions: 1, deletions: 1, binary: false
      }]
    });
    mocks.rangeChanges.mockResolvedValueOnce({
      base, head,
      changes: [{
        path: 'same.ts', fromPath: null, kind: 'modified', insertions: 1,
        deletions: 1, binary: false, commitsTouching: [head]
      }]
    });
    const store = new WorkingDiffStore();
    store.setReviewMode('/repo', {
      kind: 'range', base, head, commits: [], includeWorkingTree: true, chipFilter: null
    });
    await store.loadChanges('/repo');
    const changes = store.changesFor('/repo').result!.changes;

    await store.prefetchDiffs(
      '/repo',
      changes.map((change) => reviewEntryId(change, store.reviewModeFor('/repo')))
    );

    expect(mocks.reviewDiffs).toHaveBeenCalledTimes(2);
    expect(mocks.reviewDiffs.mock.calls.map(([request]) => request)).toEqual(
      expect.arrayContaining([
        expect.not.objectContaining({ base: expect.anything(), head: expect.anything() }),
        expect.objectContaining({ base, head })
      ])
    );
  });

  it('keys historical line windows by revision and requests the exact base commit', async () => {
    const base = 'e'.repeat(40);
    mocks.fileLines.mockResolvedValue({ lines: ['base line'], totalLines: 1 });
    const store = new WorkingDiffStore();

    expect(store.fileLinesKey('/repo', 'same.ts', 1, 1)).not.toBe(
      store.fileLinesKey('/repo', 'same.ts', 1, 1, base)
    );
    await store.loadFileLines('/repo', 'same.ts', 1, 1, base);

    expect(mocks.fileLines).toHaveBeenCalledWith({
      cwd: '/repo',
      path: 'same.ts',
      revision: { kind: 'commit', sha: base },
      startLine: 1,
      endLine: 1
    });
    expect(store.fileLinesEntry('/repo', 'same.ts', 1, 1, base).lines).toEqual(['base line']);
    expect(store.fileLinesEntry('/repo', 'same.ts', 1, 1).lines).toBeNull();
  });
});

function fileDiff(path: string): FileDiff {
  return {
    path,
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
      lines: [{ kind: 'context', oldLine: 1, newLine: 1, text: path }]
    }]
  };
}
