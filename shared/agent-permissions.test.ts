import { describe, expect, it } from 'vitest';
import type { Session } from './types/sessions.js';
import { sessionAutoApprovesPermissions } from './agent-permissions.js';

function agentSession(
  provider: 'codex' | 'claude_code',
  extraArgs: string[]
): Session {
  return {
    id: 'session-1',
    name: 'agent',
    cwd: '/repo',
    runMode: 'linux',
    launch: {
      type: 'agent',
      provider,
      resumeMode: 'new',
      extraArgs
    },
    createdAt: '2026-07-30T00:00:00.000Z',
    lastUsedAt: '2026-07-30T00:00:00.000Z'
  };
}

describe('sessionAutoApprovesPermissions', () => {
  it.each([
    ['codex', ['--dangerously-bypass-approvals-and-sandbox']],
    ['codex', ['--ask-for-approval', 'never']],
    ['codex', ['--ask-for-approval=never']],
    ['codex', ['-c', 'approval_policy="never"']],
    ['claude_code', ['--dangerously-skip-permissions']],
    ['claude_code', ['--permission-mode', 'bypassPermissions']],
    ['claude_code', ['--permission-mode=bypassPermissions']]
  ] as const)('recognizes %s auto-approval arguments', (provider, extraArgs) => {
    expect(sessionAutoApprovesPermissions(agentSession(provider, [...extraArgs]))).toBe(true);
  });

  it('does not classify an ordinary agent launch as auto-approved', () => {
    expect(sessionAutoApprovesPermissions(agentSession('codex', ['--model', 'gpt-5']))).toBe(false);
  });
});
