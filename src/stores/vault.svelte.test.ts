import { beforeEach, describe, expect, it, vi } from 'vitest';

const vaultApi = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  getSecret: vi.fn()
}));

vi.mock('../lib/ipc', () => ({
  backend: { vault: vaultApi }
}));

import { VaultStore } from './vault.svelte';
import type { VaultEntry } from '@shared/types/vault.js';

describe('VaultStore project scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
