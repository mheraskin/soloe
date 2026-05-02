import { describe, expect, it } from 'vitest';
import { AgentObserverManager, terminalStatusToObservedState } from './AgentObserverManager.js';
import type { Session } from '@shared/types/sessions.js';

const session: Session = {
  id: 'claude-main',
  kind: 'claude_code',
  name: 'Claude',
  cwd: '/workspace',
  runMode: 'windows',
  resumeMode: 'new',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: '2026-01-01T00:00:00Z'
};

describe('AgentObserverManager', () => {
  it('normalizes terminal statuses into observed agent states', () => {
    expect(terminalStatusToObservedState('starting')).toBe('starting');
    expect(terminalStatusToObservedState('running')).toBe('idle');
    expect(terminalStatusToObservedState('error')).toBe('failed');
    expect(terminalStatusToObservedState('exited')).toBe('exited');
  });

  it('registers TUI sessions and tracks status events', () => {
    const observer = new AgentObserverManager();
    observer.registerTuiSession(session);
    observer.updateTuiStatus({ sessionId: session.id, terminalId: 't-1', status: 'running' });

    const snapshot = observer.getSnapshot(session.id);
    expect(snapshot?.runtimeMode).toBe('tui');
    expect(snapshot?.state).toBe('idle');
    expect(observer.listEvents(session.id).map((e) => e.summary)).toContain('terminal running');
  });

  it('carries provider thread metadata from TUI sessions', () => {
    const observer = new AgentObserverManager();
    observer.registerTuiSession({
      ...session,
      providerThreadId: 'claude-session-123',
      transcriptPath: '/home/me/.claude/projects/-workspace/claude-session-123.jsonl',
      confidence: 0.9
    });

    expect(observer.getSnapshot(session.id)).toMatchObject({
      providerThreadId: 'claude-session-123',
      transcriptPath: '/home/me/.claude/projects/-workspace/claude-session-123.jsonl',
      confidence: 0.9
    });
  });

  it('tracks child workers by origin session', () => {
    const observer = new AgentObserverManager();
    observer.registerTuiSession(session);
    const worker = observer.registerWorker({
      workerId: 'worker-1',
      originSessionId: session.id,
      provider: 'codex',
      promptSummary: 'check tests'
    });

    expect(worker.runtimeMode).toBe('sdk_worker');
    expect(observer.childWorkers(session.id).map((s) => s.id)).toEqual(['worker-1']);
  });
});
