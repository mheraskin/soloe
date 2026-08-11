import { describe, expect, it } from 'vitest';
import {
  filterCredentialGroups,
  groupCredentialsByOrigin,
  type ScopedVaultEntry
} from './vault-groups';

const entries: ScopedVaultEntry[] = [
  scoped('one', 'https://github.com', 'ada', '/repo'),
  scoped('two', 'https://github.com', 'bea', '/repo'),
  scoped('three', 'https://gitlab.com', 'cal', '/repo-worktree')
];

describe('Vault credential groups', () => {
  it('nests every credential under its site', () => {
    expect(groupCredentialsByOrigin(entries)).toEqual([
      expect.objectContaining({
        origin: 'https://github.com',
        entries: [entries[0], entries[1]]
      }),
      expect.objectContaining({
        origin: 'https://gitlab.com',
        entries: [entries[2]]
      })
    ]);
  });

  it('searches sites, usernames, and labels without flattening the groups', () => {
    expect(filterCredentialGroups(groupCredentialsByOrigin(entries), 'gitlab')).toEqual([
      expect.objectContaining({ origin: 'https://gitlab.com', entries: [entries[2]] })
    ]);
    expect(filterCredentialGroups(groupCredentialsByOrigin(entries), 'bea')).toEqual([
      expect.objectContaining({ origin: 'https://github.com', entries: [entries[1]] })
    ]);
  });
});

function scoped(
  id: string,
  origin: string,
  username: string,
  vaultCwd: string
): ScopedVaultEntry {
  return {
    entry: {
      id,
      origin,
      username,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    vaultCwd
  };
}
