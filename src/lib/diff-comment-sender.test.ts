// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope, worktreeScopeKey } from '@shared/worktree-identity.js';
import type { DiffComment } from '../stores/diff-comments.svelte';

const state = vi.hoisted(() => ({
  comments: new Map<string, DiffComment>(),
  agents: [] as Array<{
    id: string;
    scope: ReturnType<typeof worktreeScope>;
    name: string;
    provider: 'codex' | 'claude_code';
    model?: string;
    spawnedSessionId?: string;
    createdAt: number;
  }>,
  sessions: [] as any[],
  selected: null as any,
  createAgent: vi.fn(),
  paste: vi.fn()
}));

vi.mock('../stores/diff-comments.svelte', () => ({
  diffComments: {
    byId: (id: string) => state.comments.get(id) ?? null,
    update: (id: string, patch: Partial<DiffComment>) => {
      const comment = state.comments.get(id);
      if (comment) state.comments.set(id, { ...comment, ...patch });
    }
  }
}));

vi.mock('../stores/comment-agents.svelte', () => ({
  parseMentions: (text: string) => [...text.matchAll(/(?:^|\s)@([\w-]+)/g)].map((m) => m[1]),
  commentAgents: {
    byName: (scope: ReturnType<typeof worktreeScope>, name: string) =>
      state.agents.find((agent) =>
        worktreeScopeKey(agent.scope) === worktreeScopeKey(scope) &&
        agent.name.toLowerCase() === name.toLowerCase()
      ) ?? null,
    update: (id: string, patch: Record<string, unknown>) => {
      const agent = state.agents.find((candidate) => candidate.id === id);
      if (agent) Object.assign(agent, patch);
    }
  }
}));

vi.mock('../stores/sessions.svelte', () => ({
  sessions: {
    get sessions() { return state.sessions; },
    get selected() { return state.selected; },
    createAgentWithDefaults: (...args: unknown[]) => state.createAgent(...args),
    terminalIdFor: (id: string) => state.sessions.some((session) => session.id === id)
      ? `terminal-${id}`
      : null,
    providerFor: () => 'codex'
  }
}));

vi.mock('./terminal-paste', () => ({
  sendBracketedPaste: (...args: unknown[]) => state.paste(...args)
}));

import { sendComment } from './diff-comment-sender';

describe('diff comment delivery Worktree scope', () => {
  beforeEach(() => {
    state.comments.clear();
    state.agents.length = 0;
    state.sessions.length = 0;
    state.selected = null;
    state.createAgent.mockReset();
    state.paste.mockReset().mockResolvedValue(undefined);
  });

  it('does not deliver a mentionless comment to the same path in another distro', async () => {
    const ubuntu = worktreeScope('/workspace/repo', { runMode: 'wsl', wslDistro: 'Ubuntu' });
    const debianSession = session('debian', 'Debian');
    state.sessions.push(debianSession);
    state.selected = debianSession;
    state.comments.set('comment', comment('comment', ubuntu, 'Please inspect this'));

    const result = await sendComment('comment');

    expect(result.delivered).toBe(0);
    expect(result.errors).toContain('Select a session in this Worktree to receive the comment');
    expect(state.paste).not.toHaveBeenCalled();
  });

  it('replaces a mismatched binding and spawns with exact runtime and model', async () => {
    const ubuntu = worktreeScope('/workspace/repo', { runMode: 'wsl', wslDistro: 'Ubuntu' });
    state.sessions.push(session('wrong-binding', 'Debian'));
    state.agents.push({
      id: 'agent', scope: ubuntu, name: 'reviewer', provider: 'codex',
      model: 'gpt-5-mini', spawnedSessionId: 'wrong-binding', createdAt: 1
    });
    state.comments.set('comment', comment('comment', ubuntu, '@reviewer please inspect this'));
    state.createAgent.mockImplementation(async (_provider, opts) => {
      const created = { ...session('replacement', 'Ubuntu'), ...opts };
      state.sessions.push(created);
      return created;
    });

    const result = await sendComment('comment');

    expect(state.createAgent).toHaveBeenCalledWith('codex', {
      cwd: '/workspace/repo', runMode: 'wsl', wslDistro: 'Ubuntu', model: 'gpt-5-mini'
    });
    expect(state.paste).toHaveBeenCalledWith(
      'terminal-replacement', expect.any(String), true, 'codex'
    );
    expect(result).toMatchObject({ delivered: 1, errors: [] });
  });
});

function session(id: string, wslDistro: string) {
  return {
    id,
    name: id,
    cwd: '/workspace/repo',
    runMode: 'wsl' as const,
    wslDistro,
    launch: { type: 'agent' as const, provider: 'codex' as const }
  };
}

function comment(
  id: string,
  scope: ReturnType<typeof worktreeScope>,
  text: string
): DiffComment {
  return {
    id,
    scope,
    filePath: 'src/app.ts',
    side: 'new',
    startLine: 1,
    endLine: 1,
    text,
    createdAt: 1,
    updatedAt: 1,
    mode: 'wt'
  };
}
