import { describe, expect, it, vi } from 'vitest';
import { AgentObserverManager, terminalStatusToObservedState } from './AgentObserverManager.js';
import type { Session } from '@shared/types/sessions.js';

const session: Session = {
  id: 'claude-main',
  launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' },
  name: 'Claude',
  cwd: '/workspace',
  runMode: 'windows',
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

  it('keeps usage-limited sessions visible across registration and terminal exit', () => {
    const observer = new AgentObserverManager();
    observer.registerTuiSession(session);
    observer.setTuiUsageLimit(session.id, {
      message: "You've hit your session limit · resets 3:45pm",
      resetAtLabel: '3:45pm',
      detectedAt: '2026-01-01T01:00:00Z'
    });

    observer.registerTuiSession(session);
    expect(observer.getSnapshot(session.id)).toMatchObject({
      state: 'usage_limited',
      usageLimit: { resetAtLabel: '3:45pm' }
    });

    observer.updateTuiStatus({ sessionId: session.id, terminalId: 't-1', status: 'exited' });
    expect(observer.getSnapshot(session.id)?.state).toBe('usage_limited');

    observer.updateTuiStatus({ sessionId: session.id, terminalId: 't-2', status: 'starting' });
    expect(observer.getSnapshot(session.id)?.state).toBe('starting');
    expect(observer.getSnapshot(session.id)?.usageLimit).toBeUndefined();
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

  it('carries effective approval metadata from snapshots into later events', () => {
    const observer = new AgentObserverManager();
    observer.registerTuiSession(session);

    observer.setAutoApprovesPermissions(session.id, true);
    const event = observer.appendEvent({
      subjectId: session.id,
      subjectKind: 'session',
      state: 'waiting_for_approval',
      summary: 'approval required'
    });

    expect(observer.getSnapshot(session.id)?.autoApprovesPermissions).toBe(true);
    expect(event.autoApprovesPermissions).toBe(true);
  });

  it('publishes one semantic commit for a mutation that emits event and snapshot', () => {
    const observer = new AgentObserverManager();
    const commits = vi.fn();
    const events = vi.fn();
    const snapshots = vi.fn();
    observer.on('commit', commits);
    observer.on('event', events);
    observer.on('snapshot', snapshots);

    observer.registerTuiSession(session);

    expect(events).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('commits removal so durable state cannot outlive a deleted session', () => {
    const observer = new AgentObserverManager();
    observer.registerTuiSession(session);
    const commits = vi.fn();
    observer.on('commit', commits);

    observer.removeSession(session.id);
    observer.removeSession(session.id);

    expect(observer.getSnapshot(session.id)).toBeNull();
    expect(observer.listEvents(session.id)).toEqual([]);
    expect(commits).toHaveBeenCalledTimes(1);
  });

  it('commits a worker snapshot and event pair once while preserving publication order', () => {
    const observer = new AgentObserverManager();
    observer.registerWorker({
      workerId: 'worker-1',
      originSessionId: session.id,
      provider: 'codex'
    });
    const order: string[] = [];
    observer.on('snapshot', () => order.push('snapshot'));
    observer.on('event', () => order.push('event'));
    observer.on('commit', () => order.push('commit'));

    observer.updateWorker(
      'worker-1',
      { state: 'working' },
      { summary: 'prompt received' }
    );

    expect(order).toEqual(['snapshot', 'event', 'commit']);
  });
});
