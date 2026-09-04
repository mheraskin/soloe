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
  selectedProjection: null as null | {
    ref: { deviceId: string; sessionId: string };
    session: ReturnType<typeof session>;
    runtime: { terminalId: string; sessionId: string; status: 'running' };
  },
  createAgent: vi.fn(),
  paste: vi.fn(),
  deviceInput: vi.fn()
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

vi.mock('../stores/device-sessions.svelte', () => ({
  deviceSessions: {
    get selectedProjection() { return state.selectedProjection; },
    terminalInput: (...args: unknown[]) => state.deviceInput(...args)
  }
}));

vi.mock('./terminal-paste', () => ({
  sendBracketedPaste: (...args: unknown[]) => state.paste(...args),
  sendBracketedPasteWithInput: async (
    input: (data: string) => Promise<void>,
    text: string
  ) => input(text)
}));

import { sendComment, sendComments } from './diff-comment-sender';

describe('diff comment delivery Worktree scope', () => {
  beforeEach(() => {
    state.comments.clear();
    state.agents.length = 0;
    state.sessions.length = 0;
    state.selected = null;
    state.selectedProjection = null;
    state.createAgent.mockReset();
    state.paste.mockReset().mockResolvedValue(undefined);
    state.deviceInput.mockReset().mockResolvedValue(undefined);
  });

  it('delivers a mentionless comment to the selected remote Session', async () => {
    const ubuntu = worktreeScope('/workspace/repo', {
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      deviceId: 'device-remote'
    });
    const remoteSession = session('remote', 'Ubuntu');
    state.selectedProjection = {
      ref: { deviceId: 'device-remote', sessionId: remoteSession.id },
      session: remoteSession,
      runtime: { terminalId: 'terminal-remote', sessionId: remoteSession.id, status: 'running' }
    };
    state.comments.set('comment', comment('comment', ubuntu, 'Please inspect this'));

    const result = await sendComment('comment');

    expect(result).toMatchObject({ delivered: 1, errors: [] });
    expect(state.deviceInput).toHaveBeenCalledWith(
      { deviceId: 'device-remote', terminalId: 'terminal-remote' },
      expect.stringContaining('Please inspect this')
    );
  });

  it('bundles mentionless comments for the selected remote Session', async () => {
    const ubuntu = worktreeScope('/workspace/repo', {
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      deviceId: 'device-remote'
    });
    const remoteSession = session('remote', 'Ubuntu');
    state.selectedProjection = {
      ref: { deviceId: 'device-remote', sessionId: remoteSession.id },
      session: remoteSession,
      runtime: { terminalId: 'terminal-remote', sessionId: remoteSession.id, status: 'running' }
    };
    state.comments.set('first', comment('first', ubuntu, 'First comment'));
    state.comments.set('second', comment('second', ubuntu, 'Second comment'));

    const result = await sendComments(['first', 'second']);

    expect(result).toMatchObject({ delivered: 2, errors: [] });
    expect(state.deviceInput).toHaveBeenCalledTimes(1);
    expect(state.deviceInput).toHaveBeenCalledWith(
      { deviceId: 'device-remote', terminalId: 'terminal-remote' },
      expect.stringMatching(/First comment[\s\S]*Second comment/)
    );
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
