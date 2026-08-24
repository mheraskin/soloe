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

  it('routes remote Vault requests and isolates identical paths by Device', async () => {
    const store = new VaultStore();
    vaultApi.list.mockImplementation(async (
      { cwd, deviceId }: { cwd: string; deviceId?: string }
    ) => [entry(`${deviceId ?? 'local'}:${cwd}`, deviceId ?? 'local')]);

    store.setActiveContext({ cwd: '/repo', deviceId: 'device-xps' });
    await store.ensureLoaded();
    expect(store.entries[0]?.username).toBe('device-xps');

    store.setActiveContext({ cwd: '/repo', deviceId: 'device-mba' });
    await store.ensureLoaded();
    expect(store.entries[0]?.username).toBe('device-mba');

    store.setActiveContext({ cwd: '/repo', deviceId: 'device-xps' });
    await store.ensureLoaded();
    expect(store.entries[0]?.username).toBe('device-xps');
    expect(vaultApi.list.mock.calls.map(([request]) => request)).toEqual([
      { cwd: '/repo', deviceId: 'device-xps' },
      { cwd: '/repo', deviceId: 'device-mba' }
    ]);
  });

  it('isolates identical remote paths by runtime and WSL distribution', async () => {
    const store = new VaultStore();
    vaultApi.list.mockImplementation(async (
      { cwd }: { cwd: string }
    ) => [entry(cwd, `${vaultApi.list.mock.calls.length}`)]);

    store.setActiveContext({
      cwd: '/repo',
      deviceId: 'device-xps',
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    await store.ensureLoaded();
    expect(store.entries[0]?.username).toBe('1');

    store.setActiveContext({
      cwd: '/repo',
      deviceId: 'device-xps',
      runMode: 'wsl',
      wslDistro: 'Debian'
    });
    await store.ensureLoaded();
    expect(store.entries[0]?.username).toBe('2');

    store.setActiveContext({
      cwd: '/repo',
      deviceId: 'device-xps',
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    expect(store.entries[0]?.username).toBe('1');
  });

  it('applies a completed remote mutation to the immutable request scope', async () => {
    const store = new VaultStore();
    const pending = deferred<VaultEntry>();
    vaultApi.save.mockReturnValueOnce(pending.promise);
    store.setActiveContext({
      cwd: '/repo',
      deviceId: 'device-xps',
      runMode: 'windows'
    });

    const saving = store.save({
      origin: 'https://example.test',
      username: 'xps-user',
      password: 'secret'
    });
    store.setActiveContext({
      cwd: '/repo',
      deviceId: 'device-mba',
      runMode: 'macos'
    });
    pending.resolve(entry('saved-on-xps', 'xps-user'));
    await saving;

    expect(store.entries).toEqual([]);
    store.setActiveContext({
      cwd: '/repo',
      deviceId: 'device-xps',
      runMode: 'windows'
    });
    expect(store.entries).toEqual([entry('saved-on-xps', 'xps-user')]);
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
