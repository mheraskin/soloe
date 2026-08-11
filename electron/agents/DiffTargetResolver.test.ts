import { describe, expect, it } from 'vitest';
import type { Session } from '@shared/types/sessions.js';
import { resolveDiffTarget } from './DiffTargetResolver.js';

function makeSession(id: string, distro: string): Session {
  return {
    id,
    name: id,
    cwd: '/repo',
    runMode: 'wsl',
    wslDistro: distro,
    launch: { type: 'terminal', shell: 'bash' },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('DiffTargetResolver', () => {
  const ubuntu = makeSession('ubuntu', 'Ubuntu');
  const debian = makeSession('debian', 'Debian');
  const source = (sessions: Session[]) => ({
    get: async (id: string) => sessions.find((session) => session.id === id) ?? null,
    list: async () => sessions
  });

  it('resolves an exact Session even when its path is shared across distros', async () => {
    await expect(resolveDiffTarget(source([ubuntu, debian]), {
      sessionId: 'ubuntu'
    })).resolves.toEqual({
      sessionId: 'ubuntu',
      scope: { cwd: '/repo', runMode: 'wsl', wslDistro: 'Ubuntu' }
    });
  });

  it('rejects a raw path that spans multiple Worktree identities', async () => {
    await expect(resolveDiffTarget(source([ubuntu, debian]), {
      cwd: '/repo'
    })).rejects.toThrow('cwd is ambiguous across Worktree identities; provide sessionId: /repo');
  });

  it('allows a raw path when all matching Sessions share one identity', async () => {
    const second = { ...ubuntu, id: 'ubuntu-2' };
    await expect(resolveDiffTarget(source([ubuntu, second]), {
      cwd: '/repo/'
    })).resolves.toEqual(expect.objectContaining({ sessionId: 'ubuntu' }));
  });
});
