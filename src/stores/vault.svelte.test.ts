import { beforeEach, describe, expect, it, vi } from 'vitest';

const vaultApi = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  getSecret: vi.fn(),
  onChange: vi.fn()
}));
const connectionApi = vi.hoisted(() => ({
  onReconnect: vi.fn()
}));

vi.mock('../lib/ipc', () => ({
  backend: { vault: vaultApi, connection: connectionApi }
}));

import { VaultStore } from './vault.svelte';
import type { VaultEntry } from '@shared/types/vault.js';

describe('VaultStore project scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vaultApi.onChange.mockReturnValue(vi.fn());
    connectionApi.onReconnect.mockReturnValue(vi.fn());
    vaultApi.list.mockImplementation(async ({ cwd }: { cwd: string }) => [
      entry(`${cwd}-credential`, `user@${cwd}`)
    ]);
  });

  it('loads and aggregates project root and known worktree vaults once', async () => {
    const store = new VaultStore();
    store.setActiveContext({
      cwd: '/repo/worktree-a',
      projectCwd: '/repo',
      projectScopeCwds: ['/repo/worktree-a', '/repo/worktree-b', '/repo']
    });

    await store.ensureProjectLoaded();

    expect(vaultApi.list.mock.calls.map(([request]) => request.cwd)).toEqual([
      '/repo',
      '/repo/worktree-a',
      '/repo/worktree-b'
    ]);
    expect(store.projectScopedEntries.map(({ vaultCwd }) => vaultCwd)).toEqual([
      '/repo',
      '/repo/worktree-a',
      '/repo/worktree-b'
    ]);

    await store.ensureProjectLoaded();
    expect(vaultApi.list).toHaveBeenCalledTimes(3);
  });

  it('routes fill, delete, and project saves to the credential owner', async () => {
    const store = new VaultStore();
    store.setActiveContext({ cwd: '/repo/worktree', projectCwd: '/repo' });
    vaultApi.getSecret.mockResolvedValue({ username: 'ada', password: 'secret' });
    vaultApi.delete.mockResolvedValue(undefined);
    vaultApi.save.mockResolvedValue(entry('saved', 'ada'));

    await store.getSecret('other', '/repo/other-worktree');
    await store.delete('other', '/repo/other-worktree');
    await store.save(
      { origin: 'https://example.test', username: 'ada', password: 'secret' },
      store.saveTarget('project')
    );

    expect(vaultApi.getSecret).toHaveBeenCalledWith({
      cwd: '/repo/other-worktree',
      id: 'other'
    });
    expect(vaultApi.delete).toHaveBeenCalledWith({
      cwd: '/repo/other-worktree',
      id: 'other'
    });
    expect(vaultApi.save).toHaveBeenCalledWith({
      cwd: '/repo',
      draft: {
        origin: 'https://example.test',
        username: 'ada',
        password: 'secret'
      }
    });
  });

  it('applies secret-free metadata events and refreshes loaded scopes after reconnect', async () => {
    const store = new VaultStore();
    store.setActiveContext({ cwd: '/repo', projectCwd: '/repo' });
    await store.ensureLoaded();
    store.attachListeners();
    const onChange = vaultApi.onChange.mock.calls[0]?.[0] as
      | ((event: {
          cwd: string;
          entries: VaultEntry[];
          changedAt: string;
        }) => void)
      | undefined;
    const onReconnect = connectionApi.onReconnect.mock.calls[0]?.[0] as
      | (() => void)
      | undefined;

    onChange?.({
      cwd: '/repo',
      entries: [entry('remote', 'remote-user')],
      changedAt: '2026-07-31T12:00:00.000Z'
    });
    expect(store.entries).toEqual([entry('remote', 'remote-user')]);

    vaultApi.list.mockClear();
    onReconnect?.();
    await vi.waitFor(() => expect(vaultApi.list).toHaveBeenCalledWith({ cwd: '/repo' }));
    store.detach();
  });

  it('keeps a newer metadata event when an older reconnect refresh resolves later', async () => {
    const store = new VaultStore();
    store.setActiveContext({ cwd: '/repo', projectCwd: '/repo' });
    await store.ensureLoaded();
    store.attachListeners();
    const onChange = vaultApi.onChange.mock.calls[0]?.[0] as
      | ((event: { cwd: string; entries: VaultEntry[]; changedAt: string }) => void)
      | undefined;
    const onReconnect = connectionApi.onReconnect.mock.calls[0]?.[0] as
      | (() => void)
      | undefined;
    const pending = deferred<VaultEntry[]>();
    vaultApi.list.mockReturnValueOnce(pending.promise);

    onReconnect?.();
    await vi.waitFor(() => expect(vaultApi.list).toHaveBeenCalledTimes(2));
    onChange?.({
      cwd: '/repo',
      entries: [entry('newer-event', 'event-user')],
      changedAt: '2026-07-31T12:00:01.000Z'
    });
    pending.resolve([entry('stale-refresh', 'stale-user')]);
    await pending.promise;
    await Promise.resolve();

    expect(store.entries).toEqual([entry('newer-event', 'event-user')]);
    store.detach();
  });
});

function entry(id: string, username: string): VaultEntry {
  return {
    id,
    origin: 'https://example.test',
    username,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
