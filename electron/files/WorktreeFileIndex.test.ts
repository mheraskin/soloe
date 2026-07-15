import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WorktreeFileIndex,
  type FileIndexScope,
  type WorktreeFileInventory
} from './WorktreeFileIndex.js';

const WINDOWS_SCOPE: FileIndexScope = {
  cwd: 'C:\\repo',
  runMode: 'windows'
};

describe('WorktreeFileIndex', () => {
  it('shares one materialization across a typing burst and tree consumer', async () => {
    const pending = deferred<WorktreeFileInventory>();
    const loadInventory = vi.fn(() => pending.promise);
    const index = new WorktreeFileIndex({ loadInventory });

    const tree = index.inventory(WINDOWS_SCOPE);
    const searches = Array.from({ length: 1_000 }, (_, position) =>
      index.search(WINDOWS_SCOPE, position % 2 === 0 ? 'app' : 'readme')
    );
    expect(loadInventory).toHaveBeenCalledOnce();
    pending.resolve(inventory(['src/App.svelte', 'README.md']));

    await expect(tree).resolves.toEqual(inventory(['src/App.svelte', 'README.md']));
    await Promise.all(searches);
    expect(loadInventory).toHaveBeenCalledOnce();
  });

  it('isolates identical Linux paths in different WSL distributions', async () => {
    const loadInventory = vi.fn(async (scope: FileIndexScope) =>
      inventory([`${scope.wslDistro}.txt`])
    );
    const index = new WorktreeFileIndex({ loadInventory });
    const ubuntu = { cwd: '/repo', runMode: 'wsl' as const, wslDistro: 'Ubuntu' };
    const debian = { cwd: '/repo', runMode: 'wsl' as const, wslDistro: 'Debian' };

    await expect(index.inventory(ubuntu)).resolves.toEqual(inventory(['Ubuntu.txt']));
    await expect(index.inventory(debian)).resolves.toEqual(inventory(['Debian.txt']));
    expect(loadInventory).toHaveBeenCalledTimes(2);
  });

  it('refreshes once after TTL expiry and explicit force', async () => {
    let now = 1_000;
    const loadInventory = vi.fn(async () => inventory([`generation-${loadInventory.mock.calls.length}`]));
    const index = new WorktreeFileIndex({ loadInventory, ttlMs: 100, now: () => now });

    await index.inventory(WINDOWS_SCOPE);
    now += 99;
    await index.inventory(WINDOWS_SCOPE);
    expect(loadInventory).toHaveBeenCalledTimes(1);
    now += 1;
    await index.inventory(WINDOWS_SCOPE);
    expect(loadInventory).toHaveBeenCalledTimes(2);
    await index.inventory(WINDOWS_SCOPE, { force: true });
    expect(loadInventory).toHaveBeenCalledTimes(3);
  });

  it('queues exactly one fresh follow-up when invalidated in flight', async () => {
    const first = deferred<WorktreeFileInventory>();
    const second = deferred<WorktreeFileInventory>();
    const loadInventory = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const index = new WorktreeFileIndex({ loadInventory });

    const original = index.inventory(WINDOWS_SCOPE);
    index.invalidate(WINDOWS_SCOPE);
    const afterInvalidation = index.inventory(WINDOWS_SCOPE);
    first.resolve(inventory(['stale.txt']));
    await vi.waitFor(() => expect(loadInventory).toHaveBeenCalledTimes(2));
    second.resolve(inventory(['fresh.txt']));

    await expect(original).resolves.toEqual(inventory(['fresh.txt']));
    await expect(afterInvalidation).resolves.toEqual(inventory(['fresh.txt']));
    await expect(index.inventory(WINDOWS_SCOPE)).resolves.toEqual(inventory(['fresh.txt']));
    expect(loadInventory).toHaveBeenCalledTimes(2);
  });

  it('bounds each inventory and evicts scopes by LRU', async () => {
    const loadInventory = vi.fn(async (scope: FileIndexScope) =>
      inventory([`${scope.cwd}-1`, `${scope.cwd}-2`, `${scope.cwd}-3`])
    );
    const index = new WorktreeFileIndex({ loadInventory, maxPaths: 2, maxScopes: 2 });
    const a = { cwd: 'C:\\a', runMode: 'windows' as const };
    const b = { cwd: 'C:\\b', runMode: 'windows' as const };
    const c = { cwd: 'C:\\c', runMode: 'windows' as const };

    await expect(index.inventory(a)).resolves.toMatchObject({
      paths: ['C:\\a-1', 'C:\\a-2'],
      truncated: true
    });
    await index.inventory(b);
    await index.inventory(a); // A is now most recently used.
    await index.inventory(c); // B is evicted.
    await index.inventory(b);
    expect(loadInventory).toHaveBeenCalledTimes(4);
  });

  it('constructs one exact WSL Git command and preserves NUL-delimited names', async () => {
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: 'normal.ts\0line\nbreak.ts\0',
      stderr: ''
    }));
    const index = new WorktreeFileIndex({ runCommand });
    const cwd = process.cwd();
    const scope = { cwd, runMode: 'wsl' as const, wslDistro: 'Ubuntu' };

    await expect(index.inventory(scope)).resolves.toEqual(
      inventory(['normal.ts', 'line\nbreak.ts'])
    );
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      'wsl.exe',
      [
        '-d', 'Ubuntu', '--cd', cwd, '--',
        'git', 'ls-files', '-co', '-z', '--exclude-standard'
      ],
      { stdoutLimitBytes: 32 * 1024 * 1024 }
    );
  });
});

describe('WorktreeFileIndex filesystem fallback', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-file-index-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'App.svelte'), '');
    await fs.writeFile(path.join(root, 'README.md'), '');
    await fs.writeFile(path.join(root, 'node_modules', 'ignored', 'large.js'), '');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('falls back to one bounded walk when Git is unavailable', async () => {
    const index = new WorktreeFileIndex({
      runCommand: async () => ({ code: null, stdout: '', stderr: 'missing' })
    });
    const scope = { cwd: root, runMode: 'windows' as const };

    await expect(index.inventory(scope)).resolves.toEqual({
      paths: ['README.md', 'src/App.svelte'],
      truncated: false,
      isRepo: false
    });
    await expect(index.search(scope, 'app')).resolves.toEqual([{
      rootPath: root,
      path: 'src/App.svelte',
      absolutePath: path.join(root, 'src', 'App.svelte')
    }]);
  });
});

function inventory(paths: string[]): WorktreeFileInventory {
  return { paths, truncated: false, isRepo: true };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
