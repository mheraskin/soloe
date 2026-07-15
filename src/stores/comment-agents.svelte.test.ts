// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { worktreeScope } from '@shared/worktree-identity.js';
import { CommentAgentsStore } from './comment-agents.svelte';

describe('CommentAgentsStore Worktree scope', () => {
  beforeEach(() => localStorage.clear());

  it('allows the same name independently in equal-path WSL distributions', () => {
    const cwd = '/workspace/repo';
    const ubuntu = worktreeScope(cwd, { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debian = worktreeScope(cwd, { runMode: 'wsl', wslDistro: 'Debian' });
    const store = new CommentAgentsStore();

    store.create({ scope: ubuntu, name: 'reviewer', provider: 'codex' });
    store.create({ scope: debian, name: 'reviewer', provider: 'claude_code' });

    expect(store.byName(ubuntu, 'reviewer')?.provider).toBe('codex');
    expect(store.byName(debian, 'reviewer')?.provider).toBe('claude_code');
  });

  it('re-keys valid persisted agents and rejects ambiguous WSL scopes', () => {
    const scope = worktreeScope('/workspace/repo', {
      runMode: 'wsl',
      wslDistro: 'Ubuntu'
    });
    const first = new CommentAgentsStore();
    first.create({ scope, name: 'reviewer', provider: 'codex' });
    const saved = JSON.parse(localStorage.getItem('soloe.commentAgents.v2')!);
    const valid = Object.values(saved).flat();
    localStorage.setItem(
      'soloe.commentAgents.v2',
      JSON.stringify({ wrong: [...valid, { ...(valid[0] as object), id: 'bad', scope: {
        cwd: '/workspace/repo', runMode: 'wsl'
      } }] })
    );

    const reloaded = new CommentAgentsStore();
    expect(reloaded.forScope(scope).map((agent) => agent.name)).toEqual(['reviewer']);
    expect(reloaded.byId('bad')).toBeNull();
  });

  it('adopts path-only agents only through an explicit scoped move', () => {
    const scope = worktreeScope('/workspace/legacy', {
      runMode: 'wsl', wslDistro: 'Ubuntu'
    });
    localStorage.setItem('soloe.commentAgents.v1', JSON.stringify({
      '/workspace/legacy': [{
        id: 'legacy-agent', cwd: '/workspace/legacy', name: 'reviewer',
        provider: 'codex', createdAt: 1
      }]
    }));
    const store = new CommentAgentsStore();

    expect(store.forScope(scope)).toEqual([]);
    expect(store.adoptLegacy(scope)).toBe(1);
    expect(store.byName(scope, 'reviewer')?.id).toBe('legacy-agent');
  });
});
