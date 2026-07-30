/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listTree, readFile, writeFile } = vi.hoisted(() => ({
  listTree: vi.fn(async ({ wslDistro }: { wslDistro?: string }) => ({
    paths: [`${wslDistro ?? 'native'}.txt`],
    truncated: false,
    isRepo: true
  })),
  readFile: vi.fn(async ({ relativePath, wslDistro }: {
    relativePath: string;
    wslDistro?: string;
  }) => ({
    relativePath,
    content: `${wslDistro ?? 'native'} content`,
    binary: false,
    truncated: false,
    size: 16
  })),
  writeFile: vi.fn(async () => true)
}));

vi.mock('../lib/ipc', () => ({
  ipc: { files: { listTree, readFile, writeFile } }
}));

import { createFilesScope, FilesStore } from './files.svelte';

describe('FilesStore Worktree Identity', () => {
  let store: FilesStore;
  const cwd = '/home/me/repo';

  beforeEach(() => {
    store = new FilesStore();
    listTree.mockClear();
    readFile.mockClear();
    writeFile.mockClear();
  });

  it('isolates trees and unsaved buffers for identical paths in different distros', async () => {
    const ubuntu = createFilesScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = createFilesScope(cwd, { runMode: 'wsl', wslDistro: 'Debian' });
    await store.loadTree(ubuntu);
    await store.openFileAt(ubuntu, 'README.md');
    store.setContent(ubuntu, 'Ubuntu unsaved draft');
    expect(store.treeFor(ubuntu).paths).toEqual(['Ubuntu.txt']);
    expect(store.dirtyFor(ubuntu)).toBe(true);

    expect(store.treeFor(debian).paths).toEqual([]);
    expect(store.openFileFor(debian)).toBeNull();
    await store.loadTree(debian);
    await store.openFileAt(debian, 'README.md');
    expect(store.treeFor(debian).paths).toEqual(['Debian.txt']);
    expect(store.openFileFor(debian)?.content).toBe('Debian content');

    expect(store.openFileFor(ubuntu)?.content).toBe('Ubuntu unsaved draft');
    await store.save(ubuntu);

    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({
      cwd,
      relativePath: 'README.md',
      content: 'Ubuntu unsaved draft',
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    }));
  });

  it('keeps edits made during a save dirty against the exact saved snapshot', async () => {
    const scope = createFilesScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const pending = deferred<true>();
    writeFile.mockReturnValueOnce(pending.promise);
    await store.openFileAt(scope, 'README.md');
    store.setContent(scope, 'saved snapshot');

    const saving = store.save(scope);
    store.setContent(scope, 'newer local edit');
    pending.resolve(true);
    await saving;

    expect(store.openFileFor(scope)).toEqual(expect.objectContaining({
      content: 'newer local edit',
      baseline: 'saved snapshot',
      saving: false
    }));
    expect(store.dirtyFor(scope)).toBe(true);
  });

  it('blocks accidental file switches until dirty-buffer discard is explicit', async () => {
    const scope = createFilesScope(cwd, { runMode: 'windows' });
    await store.openFileAt(scope, 'first.ts');
    store.setContent(scope, 'unsaved first file');

    expect(await store.openFileAt(scope, 'second.ts')).toBe(false);
    expect(store.openFileFor(scope)).toEqual(expect.objectContaining({
      relativePath: 'first.ts',
      content: 'unsaved first file'
    }));
    expect(readFile).toHaveBeenCalledTimes(1);

    expect(await store.openFileAt(scope, 'second.ts', { discardDirty: true })).toBe(true);
    expect(store.openFileFor(scope)?.relativePath).toBe('second.ts');
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('preserves an explicit bounded-preview marker from the file service', async () => {
    readFile.mockResolvedValueOnce({
      relativePath: 'large.log',
      content: 'preview content',
      binary: false,
      truncated: true,
      size: 1_000_000
    });
    const scope = createFilesScope(cwd, { runMode: 'windows' });

    await store.openFileAt(scope, 'large.log');

    expect(store.openFileFor(scope)).toEqual(expect.objectContaining({
      relativePath: 'large.log',
      content: 'preview content',
      truncated: true,
      size: 1_000_000
    }));
    expect(store.dirtyFor(scope)).toBe(false);
  });

  it('reuses tree and unsaved file state when the Files Rail Surface remounts', async () => {
    const scope = createFilesScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const release = store.acquirePayloadResidency(scope);
    await store.loadTree(scope);
    await store.openFileAt(scope, 'README.md');
    store.setContent(scope, 'draft retained outside renderer residency');
    release();

    // These are the same reads performed by a freshly mounted Files surface.
    // Store ownership means neither needs another host filesystem request.
    const releaseRemount = store.acquirePayloadResidency(scope);
    await store.loadTree(scope);
    await store.openFileAt(scope, 'README.md');

    expect(listTree).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(store.openFileFor(scope)?.content).toBe('draft retained outside renderer residency');
    expect(store.dirtyFor(scope)).toBe(true);
    releaseRemount();
  });

  it('bounds released clean tree and editor payload to two recent scopes', async () => {
    const scopes = Array.from({ length: 6 }, (_, index) =>
      createFilesScope(`${cwd}-${index}`, { runMode: 'windows' })
    );
    for (const scope of scopes) {
      const release = store.acquirePayloadResidency(scope);
      await store.loadTree(scope);
      await store.openFileAt(scope, 'README.md');
      release();
    }

    for (const scope of scopes.slice(0, -2)) {
      expect(store.treeFor(scope).paths).toEqual([]);
      expect(store.openFileFor(scope)).toBeNull();
    }
    for (const scope of scopes.slice(-2)) {
      expect(store.treeFor(scope).paths).toEqual(['native.txt']);
      expect(store.openFileFor(scope)?.content).toBe('native content');
    }
  });

  it('reclaims an old tree without discarding its unsaved buffer', async () => {
    const dirtyScope = createFilesScope(`${cwd}-dirty`, { runMode: 'windows' });
    const releaseDirty = store.acquirePayloadResidency(dirtyScope);
    await store.loadTree(dirtyScope);
    await store.openFileAt(dirtyScope, 'README.md');
    store.setContent(dirtyScope, 'unsaved continuity');
    releaseDirty();

    for (let index = 0; index < 3; index += 1) {
      const scope = createFilesScope(`${cwd}-clean-${index}`, { runMode: 'windows' });
      const release = store.acquirePayloadResidency(scope);
      await store.loadTree(scope);
      await store.openFileAt(scope, 'README.md');
      release();
    }

    expect(store.treeFor(dirtyScope).paths).toEqual([]);
    expect(store.openFileFor(dirtyScope)?.content).toBe('unsaved continuity');
    expect(store.dirtyFor(dirtyScope)).toBe(true);

    const readsBeforeRemount = readFile.mock.calls.length;
    const releaseRemount = store.acquirePayloadResidency(dirtyScope);
    await store.loadTree(dirtyScope);
    await store.openFileAt(dirtyScope, 'README.md');
    expect(listTree).toHaveBeenCalledTimes(5);
    expect(readFile).toHaveBeenCalledTimes(readsBeforeRemount);
    releaseRemount();
  });

  it('keeps payload resident until the final surface owner releases it', async () => {
    const scope = createFilesScope(`${cwd}-shared`, { runMode: 'windows' });
    const releaseFirst = store.acquirePayloadResidency(scope);
    const releaseSecond = store.acquirePayloadResidency(scope);
    await store.loadTree(scope);
    await store.openFileAt(scope, 'README.md');
    releaseFirst();

    for (let index = 0; index < 3; index += 1) {
      const other = createFilesScope(`${cwd}-other-${index}`, { runMode: 'windows' });
      const release = store.acquirePayloadResidency(other);
      await store.loadTree(other);
      release();
    }

    expect(store.treeFor(scope).paths).toEqual(['native.txt']);
    expect(store.openFileFor(scope)?.content).toBe('native content');
    releaseSecond();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
