/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import type { DiffRpcRequest } from '@shared/types/diff-rpc.js';
import type { GitCommit } from '@shared/types/git.js';
import type { Session } from '@shared/types/sessions.js';
import { dispatchDiffRequest, type DiffRequestDeps } from './diff-bridge-handler';

const COMMIT: GitCommit = {
  hash: 'a'.repeat(40),
  shortHash: 'aaaaaaa',
  author: 'A',
  authoredAt: '2026-01-01T00:00:00.000Z',
  subject: 'Scoped bridge'
};

function session(id: string, distro: string): Session {
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

function request(distro = 'Ubuntu'): DiffRpcRequest {
  return {
    requestId: 'request-1',
    op: 'open_for_commits',
    args: {
      target: {
        sessionId: 'ubuntu',
        scope: { cwd: '/repo', runMode: 'wsl', wslDistro: distro }
      },
      base: 'b'.repeat(40),
      head: COMMIT.hash,
      commits: [COMMIT],
      includeWorkingTree: true,
      focusPath: 'src/app.ts'
    }
  };
}

function deps(): DiffRequestDeps {
  return {
    sessions: {
      sessions: [session('ubuntu', 'Ubuntu'), session('debian', 'Debian')],
      select: vi.fn()
    },
    workingDiff: {
      setReviewMode: vi.fn(),
      setSelected: vi.fn()
    },
    rightRail: {
      setActiveCwd: vi.fn(),
      openTab: vi.fn()
    }
  };
}

describe('diff bridge renderer dispatch', () => {
  it('selects and publishes only the exact scoped Session', async () => {
    const adapters = deps();
    const result = await dispatchDiffRequest(request(), adapters);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sessionId: 'ubuntu',
      commitCount: 1
    }));
    expect(adapters.sessions.select).toHaveBeenCalledWith('ubuntu');
    expect(adapters.workingDiff.setReviewMode).toHaveBeenCalledWith(
      expect.objectContaining({ wslDistro: 'Ubuntu' }),
      expect.objectContaining({ commits: [COMMIT] })
    );
    expect(adapters.workingDiff.setSelected).toHaveBeenCalledWith(
      expect.objectContaining({ wslDistro: 'Ubuntu' }),
      'src/app.ts',
      'committed'
    );
    expect(adapters.rightRail.openTab).toHaveBeenCalledWith('diff');
  });

  it('rejects a Session/scope mismatch without mutating UI state', async () => {
    const adapters = deps();
    const result = await dispatchDiffRequest(request('Debian'), adapters);

    expect(result).toEqual({ ok: false, error: 'session Worktree Scope mismatch: ubuntu' });
    expect(adapters.sessions.select).not.toHaveBeenCalled();
    expect(adapters.workingDiff.setReviewMode).not.toHaveBeenCalled();
    expect(adapters.rightRail.openTab).not.toHaveBeenCalled();
  });
});
