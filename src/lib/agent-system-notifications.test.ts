/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import type { AgentToastNotice } from '../stores/agent-notifications.svelte';
import {
  agentNotificationStateLabel,
  agentProviderLabel,
  agentSystemNotificationContent
} from './agent-system-notifications';

const notice = {
  sessionId: 'codex-1',
  subjectId: 'codex-1',
  state: 'completed',
  reason: 'implementation finished',
  createdAt: 1,
  sequence: 1,
  sessionName: 'Checkout fix',
  sessionKind: 'codex',
  cwd: '/projects/storefront',
  runMode: 'wsl'
} satisfies AgentToastNotice;

describe('agent system notifications', () => {
  it('puts the state first and provider plus session context on the subline', () => {
    expect(agentSystemNotificationContent(notice)).toEqual({
      title: 'Tab finished working',
      body: 'Codex · storefront · Checkout fix',
      tag: 'soloe-agent-codex-1'
    });
  });

  it('uses user-facing state and provider labels', () => {
    expect(agentNotificationStateLabel('waiting_for_approval')).toBe('Approval needed');
    expect(agentProviderLabel('claude_code')).toBe('Claude Code');
  });
});
