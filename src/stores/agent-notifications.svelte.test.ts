/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type { Session } from '@shared/types/sessions.js';
import { agentNotifications } from './agent-notifications.svelte';

const session = {
  id: 's-1',
  kind: 'codex',
  name: 'Codex',
  cwd: '/repo',
  runMode: 'wsl',
  createdAt: '2026-05-04T00:00:00.000Z',
  lastUsedAt: '2026-05-04T00:00:00.000Z',
  resumeMode: 'new'
} satisfies Session;

function snapshot(
  state: ObservedAgentSnapshot['state'],
  overrides: Partial<ObservedAgentSnapshot> = {}
): ObservedAgentSnapshot {
  return {
    id: session.id,
    runtimeMode: 'tui',
    subjectKind: 'session',
    provider: 'codex',
    state,
    sessionId: session.id,
    lastEventAt: '2026-05-04T00:00:00.000Z',
    ...overrides
  };
}

describe('agentNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentNotifications.reset();
  });

  afterEach(() => {
    agentNotifications.reset();
    vi.useRealTimers();
  });

  it('creates a marker and toast when an inactive session enters a notify state', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, null);
    agentNotifications.observeSnapshot(snapshot('waiting_for_input'), session, null);

    expect(agentNotifications.markerFor(session.id)?.state).toBe('waiting_for_input');
    expect(agentNotifications.toasts).toHaveLength(1);
    expect(agentNotifications.toasts[0]?.sessionName).toBe('Codex');
  });

  it('does not notify for the active session', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, session.id);
    agentNotifications.observeSnapshot(snapshot('waiting_for_approval'), session, session.id);

    expect(agentNotifications.markerFor(session.id)).toBeNull();
    expect(agentNotifications.toasts).toHaveLength(0);
  });

  it('dedupes toasts per session and replaces the older notice', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, null);
    agentNotifications.observeSnapshot(snapshot('waiting_for_input'), session, null);
    agentNotifications.observeSnapshot(snapshot('failed', { error: 'tool crashed' }), session, null);

    expect(agentNotifications.toasts).toHaveLength(1);
    expect(agentNotifications.toasts[0]?.state).toBe('failed');
    expect(agentNotifications.toasts[0]?.reason).toBe('tool crashed');
  });

  it('acknowledges a session by clearing its marker and toast', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, null);
    agentNotifications.observeSnapshot(snapshot('failed'), session, null);

    agentNotifications.acknowledge(session.id);

    expect(agentNotifications.markerFor(session.id)).toBeNull();
    expect(agentNotifications.toasts).toHaveLength(0);
  });

  it('clears an approval marker when the session is opened', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, null);
    agentNotifications.observeSnapshot(snapshot('waiting_for_approval'), session, null);

    agentNotifications.markSessionOpened(session.id);

    expect(agentNotifications.markerFor(session.id)).toBeNull();
    expect(agentNotifications.toasts).toHaveLength(0);
  });

  it('clears existing approval notifications during active session refreshes', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, null);
    agentNotifications.observeSnapshot(snapshot('waiting_for_approval'), session, null);

    agentNotifications.observeSnapshot(
      snapshot('waiting_for_approval', { promptSummary: 'approve file write' }),
      session,
      session.id
    );

    expect(agentNotifications.markerFor(session.id)).toBeNull();
    expect(agentNotifications.toasts).toHaveLength(0);
  });

  it('clears completed markers when the session is opened', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, null);
    agentNotifications.observeSnapshot(snapshot('completed'), session, null);

    agentNotifications.markSessionOpened(session.id);

    expect(agentNotifications.markerFor(session.id)).toBeNull();
    expect(agentNotifications.toasts).toHaveLength(0);
  });

  it('auto-dismisses completed toasts', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, null);
    agentNotifications.observeSnapshot(snapshot('completed', { resultSummary: 'done' }), session, null);

    expect(agentNotifications.toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);

    expect(agentNotifications.toasts).toHaveLength(0);
    expect(agentNotifications.markerFor(session.id)?.state).toBe('completed');
  });

  it('pulses only the most urgent unacknowledged row', () => {
    const failed = { ...session, id: 's-2', name: 'Failed' } satisfies Session;

    agentNotifications.observeSnapshot(snapshot('working'), session, null);
    agentNotifications.observeSnapshot(snapshot('completed'), session, null);
    agentNotifications.observeSnapshot(
      snapshot('working', { id: failed.id, sessionId: failed.id }),
      failed,
      null
    );
    agentNotifications.observeSnapshot(
      snapshot('failed', { id: failed.id, sessionId: failed.id }),
      failed,
      null
    );

    expect(agentNotifications.pulsingSessionId).toBe(failed.id);
  });
});
