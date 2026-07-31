/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservedAgentSnapshot, ObserverEvent } from '@shared/types/agents.js';
import type { Session } from '@shared/types/sessions.js';
import { agentNotifications } from './agent-notifications.svelte';

const session = {
  id: 's-1',
  launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
  name: 'Codex',
  cwd: '/repo',
  runMode: 'wsl',
  createdAt: '2026-05-04T00:00:00.000Z',
  lastUsedAt: '2026-05-04T00:00:00.000Z'
} satisfies Session;

const autoApprovedSession = {
  ...session,
  launch: {
    type: 'agent',
    provider: 'codex',
    resumeMode: 'new',
    extraArgs: ['--dangerously-bypass-approvals-and-sandbox']
  }
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

function event(state: ObserverEvent['state'], summary: string): ObserverEvent {
  return {
    id: `event-${state}`,
    subjectId: session.id,
    subjectKind: 'session',
    timestamp: '2026-05-04T00:00:00.000Z',
    state,
    summary
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

  it('still notifies the active session when the app is not focused', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, session.id, false);
    agentNotifications.observeSnapshot(snapshot('waiting_for_approval'), session, session.id, false);

    expect(agentNotifications.markerFor(session.id)?.state).toBe('waiting_for_approval');
    expect(agentNotifications.toasts).toHaveLength(1);
  });

  it('never notifies for approval when the Codex session auto-approves permissions', () => {
    agentNotifications.observeSnapshot(snapshot('working'), autoApprovedSession, null);
    agentNotifications.observeSnapshot(
      snapshot('waiting_for_approval'),
      autoApprovedSession,
      null
    );

    expect(agentNotifications.markerFor(autoApprovedSession.id)).toBeNull();
    expect(agentNotifications.toasts).toHaveLength(0);
  });

  it('does not restore an approval marker for an auto-approved Codex snapshot', () => {
    agentNotifications.primeSnapshot(
      snapshot('waiting_for_approval'),
      autoApprovedSession,
      null
    );

    expect(agentNotifications.markerFor(autoApprovedSession.id)).toBeNull();
  });

  it('suppresses notifications and blinking for the focused active session', () => {
    agentNotifications.observeSnapshot(snapshot('working'), session, session.id, true);
    agentNotifications.observeSnapshot(snapshot('completed'), session, session.id, true);

    expect(agentNotifications.markerFor(session.id)).toBeNull();
    expect(agentNotifications.toasts).toHaveLength(0);
  });

  it('does not dismiss a toast when the matching snapshot follows its observer event', () => {
    agentNotifications.observeEvent(
      event('waiting_for_approval', 'approval: ExitPlanMode'),
      session,
      session.id,
      session.id
    );
    agentNotifications.observeSnapshot(snapshot('waiting_for_approval'), session, session.id);

    expect(agentNotifications.markerFor(session.id)?.state).toBe('waiting_for_approval');
    expect(agentNotifications.toasts).toMatchObject([
      {
        state: 'waiting_for_approval',
        reason: 'approval: ExitPlanMode'
      }
    ]);
  });

  it('keeps completion visible when the matching snapshot follows its observer event', () => {
    agentNotifications.observeEvent(
      event('completed', 'task completed'),
      session,
      session.id,
      session.id
    );
    agentNotifications.observeSnapshot(snapshot('completed'), session, session.id);

    expect(agentNotifications.markerFor(session.id)?.state).toBe('completed');
    expect(agentNotifications.toasts).toMatchObject([
      {
        state: 'completed',
        reason: 'task completed'
      }
    ]);
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
    vi.advanceTimersByTime(5999);

    expect(agentNotifications.toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);

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
