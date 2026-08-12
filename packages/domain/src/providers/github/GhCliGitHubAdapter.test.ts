import { describe, expect, it, vi } from 'vitest';

import { GhCliGitHubAdapter } from './GhCliGitHubAdapter.js';

describe('GhCliGitHubAdapter', () => {
  it('uses semantic gh API argument arrays and maps repository identity without leaking output', async () => {
    const run = vi.fn(async (_binary: string, args: string[]) => {
      if (args.join(' ') === 'auth status --hostname github.com') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args.join(' ') === 'api user') {
        return { code: 0, stdout: JSON.stringify({ login: 'mhera' }), stderr: '' };
      }
      if (args.includes('--method')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            node_id: 'R_123',
            html_url: 'https://github.com/acme/compiler',
            ssh_url: 'git@github.com:acme/compiler.git',
            private: true,
            owner: { login: 'acme' },
            name: 'compiler'
          }),
          stderr: ''
        };
      }
      throw new Error(`Unexpected gh call: ${args.join(' ')}`);
    });
    const adapter = new GhCliGitHubAdapter({ binary: 'gh-test', run });

    await expect(adapter.status()).resolves.toMatchObject({
      available: true,
      authenticated: true,
      login: 'mhera'
    });
    await expect(adapter.createRepository({
      kind: 'create-github-repository',
      owner: 'acme',
      name: 'compiler',
      visibility: 'private',
      description: 'Compiler'
    })).resolves.toMatchObject({ providerRepositoryId: 'R_123', visibility: 'private' });
    expect(run).toHaveBeenLastCalledWith('gh-test', [
      'api', '--method', 'POST', 'orgs/acme/repos',
      '-f', 'name=compiler', '-F', 'private=true', '-f', 'description=Compiler'
    ]);
  });
});
