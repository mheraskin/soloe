import { describe, expect, it } from 'vitest';
import { sessionStatusPresentation } from './session-status-presentation';

describe('session status presentation', () => {
  it('presents a remote idle observation in expanded and collapsed navigation', () => {
    const presentation = sessionStatusPresentation({
      session: {
        id: 'session-1',
        name: 'Remote Codex',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
        createdAt: '2026-08-16T00:00:00.000Z',
        lastUsedAt: '2026-08-16T00:00:00.000Z'
      },
      status: 'running',
      observed: {
        id: 'session-1',
        sessionId: 'session-1',
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'codex',
        state: 'idle'
      },
      observedSummary: null,
      hasRuntime: true,
      hasNotificationMarker: false
    });

    expect(presentation.agentState).toBe('idle');
    expect(presentation.statusDot).toEqual({ tone: 'active', title: 'idle' });
    expect(presentation.working).toBe(false);
  });

  it('falls back to an exited lifecycle when no observation is available', () => {
    const presentation = sessionStatusPresentation({
      session: {
        id: 'session-1',
        name: 'Remote terminal',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'terminal', shell: 'auto' },
        createdAt: '2026-08-16T00:00:00.000Z',
        lastUsedAt: '2026-08-16T00:00:00.000Z'
      },
      status: 'exited',
      observed: null,
      observedSummary: null,
      hasRuntime: true,
      hasNotificationMarker: false
    });

    expect(presentation.statusDot).toEqual({ tone: 'done', title: 'exited' });
    expect(presentation.working).toBe(false);
  });

  it('gives an exited lifecycle precedence over a stale idle observation', () => {
    const presentation = sessionStatusPresentation({
      session: {
        id: 'session-1',
        name: 'Remote Codex',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
        createdAt: '2026-08-16T00:00:00.000Z',
        lastUsedAt: '2026-08-16T00:00:00.000Z'
      },
      status: 'exited',
      observed: {
        id: 'session-1',
        sessionId: 'session-1',
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'codex',
        state: 'idle'
      },
      observedSummary: null,
      hasRuntime: false,
      hasNotificationMarker: false
    });

    expect(presentation.agentState).toBeNull();
    expect(presentation.statusDot).toEqual({ tone: 'done', title: 'exited' });
    expect(presentation.working).toBe(false);
  });

  it('gives a remote exited runtime row precedence over a stale idle observation', () => {
    const presentation = sessionStatusPresentation({
      session: {
        id: 'session-1',
        name: 'Remote Cursor',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'cursor', resumeMode: 'new' },
        createdAt: '2026-08-16T00:00:00.000Z',
        lastUsedAt: '2026-08-16T00:00:00.000Z'
      },
      status: 'exited',
      observed: {
        id: 'session-1',
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'cursor',
        state: 'idle'
      },
      observedSummary: 'idle',
      hasRuntime: true,
      hasNotificationMarker: false
    });

    expect(presentation.agentState).toBeNull();
    expect(presentation.statusDot).toEqual({ tone: 'done', title: 'exited' });
    expect(presentation.working).toBe(false);
  });

  it('presents normalized remote work instead of a stale legacy idle state', () => {
    const presentation = sessionStatusPresentation({
      session: {
        id: 'session-1',
        name: 'Remote Cursor',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'cursor', resumeMode: 'new' },
        createdAt: '2026-08-16T00:00:00.000Z',
        lastUsedAt: '2026-08-16T00:00:00.000Z'
      },
      status: 'running',
      observed: {
        id: 'session-1',
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'cursor',
        state: 'idle',
        interactive: {
          lifecycle: 'running',
          turn: 'working',
          attention: { kind: 'none' },
          observation: 'exact',
          lastEventAt: '2026-08-16T00:00:01.000Z'
        }
      },
      observedSummary: 'thinking',
      hasRuntime: true,
      hasNotificationMarker: false
    });

    expect(presentation.agentState).toBe('working');
    expect(presentation.statusDot).toBeNull();
    expect(presentation.working).toBe(true);
  });

  it('keeps normalized approval attention visible while the turn is active', () => {
    const presentation = sessionStatusPresentation({
      session: {
        id: 'session-1',
        name: 'Remote Codex',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
        createdAt: '2026-08-16T00:00:00.000Z',
        lastUsedAt: '2026-08-16T00:00:00.000Z'
      },
      status: 'running',
      observed: {
        id: 'session-1',
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'codex',
        state: 'working',
        interactive: {
          lifecycle: 'running',
          turn: 'running_tool',
          attention: { kind: 'approval', requestKey: 'request-1' },
          observation: 'exact',
          lastEventAt: '2026-08-16T00:00:01.000Z'
        }
      },
      observedSummary: 'approve shell command',
      hasRuntime: true,
      hasNotificationMarker: false
    });

    expect(presentation.agentState).toBe('waiting_for_approval');
    expect(presentation.statusDot).toEqual({
      tone: 'issue',
      title: 'waiting for approval · approve shell command'
    });
    expect(presentation.working).toBe(false);
  });
});
