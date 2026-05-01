import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type {
  ObservedAgentSnapshot,
  ObserverEvent,
  ObserverSubjectKind
} from '@shared/types/agents.js';
import type {
  AgentObservedState,
  Session,
  SessionId,
  SessionStatus
} from '@shared/types/sessions.js';
import type { TerminalStatusEvent } from '@shared/types/terminal.js';

type AgentObserverEvents = {
  snapshot: [ObservedAgentSnapshot];
  event: [ObserverEvent];
};

export interface AgentObserverManagerOptions {
  maxEventsPerSubject?: number;
  initialSnapshots?: ObservedAgentSnapshot[];
  initialEvents?: ObserverEvent[];
}

export declare interface AgentObserverManager {
  on<K extends keyof AgentObserverEvents>(
    event: K,
    listener: (...args: AgentObserverEvents[K]) => void
  ): this;
  off<K extends keyof AgentObserverEvents>(
    event: K,
    listener: (...args: AgentObserverEvents[K]) => void
  ): this;
  emit<K extends keyof AgentObserverEvents>(event: K, ...args: AgentObserverEvents[K]): boolean;
}

export class AgentObserverManager extends EventEmitter {
  private readonly snapshots = new Map<string, ObservedAgentSnapshot>();
  private readonly eventsBySubject = new Map<string, ObserverEvent[]>();
  private readonly maxEventsPerSubject: number;

  constructor(opts: AgentObserverManagerOptions = {}) {
    super();
    this.maxEventsPerSubject = opts.maxEventsPerSubject ?? 30;
    for (const snapshot of opts.initialSnapshots ?? []) {
      this.snapshots.set(snapshot.id, snapshot);
    }
    for (const event of opts.initialEvents ?? []) {
      const list = this.eventsBySubject.get(event.subjectId) ?? [];
      list.push(event);
      this.eventsBySubject.set(event.subjectId, list);
    }
  }

  registerTuiSession(session: Session): ObservedAgentSnapshot {
    const snapshot: ObservedAgentSnapshot = {
      id: session.id,
      runtimeMode: 'tui',
      subjectKind: 'session',
      provider: session.kind,
      state: 'idle',
      sessionId: session.id,
      lastEventAt: new Date().toISOString()
    };
    return this.upsertSnapshot(snapshot, 'session registered');
  }

  removeSession(sessionId: SessionId): void {
    this.snapshots.delete(sessionId);
    this.eventsBySubject.delete(sessionId);
  }

  updateTuiStatus(event: TerminalStatusEvent): ObservedAgentSnapshot {
    const existing = this.snapshots.get(event.sessionId);
    const state = terminalStatusToObservedState(event.status);
    const snapshot: ObservedAgentSnapshot = {
      ...(existing ?? {
        id: event.sessionId,
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'standard_terminal',
        sessionId: event.sessionId
      }),
      state,
      lastEventAt: new Date().toISOString(),
      ...(event.message ? { error: event.message } : {})
    };
    return this.upsertSnapshot(snapshot, event.message ?? `terminal ${event.status}`);
  }

  registerWorker(input: {
    workerId: string;
    originSessionId: SessionId;
    provider: 'claude_code' | 'codex';
    promptSummary?: string;
    providerThreadId?: string;
    transcriptPath?: string;
  }): ObservedAgentSnapshot {
    const now = new Date().toISOString();
    const snapshot: ObservedAgentSnapshot = {
      id: input.workerId,
      runtimeMode: 'sdk_worker',
      subjectKind: 'worker',
      provider: input.provider,
      state: 'idle',
      workerId: input.workerId,
      originSessionId: input.originSessionId,
      providerThreadId: input.providerThreadId,
      transcriptPath: input.transcriptPath,
      promptSummary: input.promptSummary,
      lastEventAt: now,
      confidence: 0.5
    };
    return this.upsertSnapshot(snapshot, 'worker registered');
  }

  updateWorker(
    workerId: string,
    patch: Partial<Omit<ObservedAgentSnapshot, 'id' | 'runtimeMode' | 'subjectKind' | 'workerId'>>
  ): ObservedAgentSnapshot {
    const existing = this.snapshots.get(workerId);
    if (!existing || existing.subjectKind !== 'worker') {
      throw new Error(`Worker not found: ${workerId}`);
    }
    return this.upsertSnapshot({
      ...existing,
      ...patch,
      id: workerId,
      runtimeMode: 'sdk_worker',
      subjectKind: 'worker',
      workerId,
      lastEventAt: patch.lastEventAt ?? new Date().toISOString()
    });
  }

  appendEvent(input: {
    subjectId: string;
    subjectKind: ObserverSubjectKind;
    state: AgentObservedState;
    summary: string;
    detail?: string;
  }): ObserverEvent {
    const event: ObserverEvent = {
      id: `evt-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      subjectId: input.subjectId,
      subjectKind: input.subjectKind,
      timestamp: new Date().toISOString(),
      state: input.state,
      summary: input.summary,
      detail: input.detail
    };
    const list = this.eventsBySubject.get(input.subjectId) ?? [];
    list.push(event);
    if (list.length > this.maxEventsPerSubject) {
      list.splice(0, list.length - this.maxEventsPerSubject);
    }
    this.eventsBySubject.set(input.subjectId, list);
    this.emit('event', event);
    return event;
  }

  listSnapshots(): ObservedAgentSnapshot[] {
    return [...this.snapshots.values()].sort((a, b) =>
      (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? '')
    );
  }

  listEvents(subjectId?: string, limit?: number): ObserverEvent[] {
    const events = subjectId
      ? [...(this.eventsBySubject.get(subjectId) ?? [])]
      : [...this.eventsBySubject.values()].flat();
    const sorted = events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return typeof limit === 'number' ? sorted.slice(0, Math.max(0, limit)) : sorted;
  }

  getSnapshot(id: string): ObservedAgentSnapshot | null {
    return this.snapshots.get(id) ?? null;
  }

  childWorkers(originSessionId: SessionId): ObservedAgentSnapshot[] {
    return this.listSnapshots().filter(
      (s) => s.subjectKind === 'worker' && s.originSessionId === originSessionId
    );
  }

  private upsertSnapshot(
    snapshot: ObservedAgentSnapshot,
    eventSummary?: string
  ): ObservedAgentSnapshot {
    this.snapshots.set(snapshot.id, snapshot);
    if (eventSummary) {
      this.appendEvent({
        subjectId: snapshot.id,
        subjectKind: snapshot.subjectKind,
        state: snapshot.state,
        summary: eventSummary
      });
    }
    this.emit('snapshot', snapshot);
    return snapshot;
  }
}

export function terminalStatusToObservedState(status: SessionStatus): AgentObservedState {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'running':
      return 'idle';
    case 'error':
      return 'failed';
    case 'exited':
    case 'stopped':
      return 'exited';
  }
}
