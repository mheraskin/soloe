import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type {
  AgentUsageLimit,
  InteractiveAgentProjection,
  ObservedAgentSnapshot,
  ObserverEvent,
  ObserverSubjectKind
} from '@shared/types/agents.js';
import type { InteractiveAgentEvent } from '@shared/interactive-agent-projection.js';
import {
  initialInteractiveAgentProjection,
  reduceInteractiveAgentProjection
} from '@shared/interactive-agent-projection.js';
import type {
  AgentObservedState,
  Session,
  SessionId,
  SessionStatus
} from '@shared/types/sessions.js';
import { effectiveAgentProvider } from '@shared/types/sessions.js';
import type { TerminalStatusEvent } from '@shared/types/terminal.js';

type AgentObserverEvents = {
  snapshot: [ObservedAgentSnapshot];
  event: [ObserverEvent];
  // One notification per completed semantic mutation. Presentation channels
  // above may both fire for one mutation; durability must not treat those as
  // two independent write commands.
  commit: [];
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
  private readonly eventOrder = new WeakMap<ObserverEvent, number>();
  private readonly maxEventsPerSubject: number;
  private nextEventOrder = 0;

  constructor(opts: AgentObserverManagerOptions = {}) {
    super();
    this.maxEventsPerSubject = opts.maxEventsPerSubject ?? 30;
    for (const snapshot of opts.initialSnapshots ?? []) {
      this.snapshots.set(snapshot.id, snapshot);
    }
    for (const event of opts.initialEvents ?? []) {
      this.eventOrder.set(event, this.nextEventOrder++);
      const list = this.eventsBySubject.get(event.subjectId) ?? [];
      list.push(event);
      this.eventsBySubject.set(event.subjectId, list);
    }
  }

  registerTuiSession(session: Session): ObservedAgentSnapshot {
    const existing = this.snapshots.get(session.id);
    const snapshot: ObservedAgentSnapshot = {
      ...(existing?.state === 'usage_limited' ? existing : {}),
      id: session.id,
      runtimeMode: 'tui',
      subjectKind: 'session',
      provider: effectiveAgentProvider(session) ?? 'terminal',
      state: existing?.state === 'usage_limited' ? 'usage_limited' : 'idle',
      sessionId: session.id,
      providerThreadId: session.currentAgentRuntime?.providerThreadId ?? session.providerThreadId,
      transcriptPath: session.transcriptPath ?? existing?.transcriptPath,
      confidence: session.confidence,
      interactive: existing?.interactive ?? initialInteractiveAgentProjection('degraded'),
      lastEventAt: new Date().toISOString()
    };
    return this.upsertSnapshot(snapshot, 'session registered');
  }

  removeSession(sessionId: SessionId): void {
    const removedSnapshot = this.snapshots.delete(sessionId);
    const removedEvents = this.eventsBySubject.delete(sessionId);
    if (removedSnapshot || removedEvents) this.emit('commit');
  }

  updateTuiStatus(event: TerminalStatusEvent): ObservedAgentSnapshot {
    const existing = this.snapshots.get(event.sessionId);
    const state =
      existing?.state === 'usage_limited' && event.status !== 'starting'
        ? 'usage_limited'
        : terminalStatusToObservedState(event.status);
    const snapshot: ObservedAgentSnapshot = {
      ...(existing ?? {
        id: event.sessionId,
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'terminal',
        sessionId: event.sessionId
      }),
      state,
      interactive: projectionForTerminalStatus(existing?.interactive, event.status, state),
      lastEventAt: new Date().toISOString(),
      ...(event.message ? { error: event.message } : {})
    };
    if (state !== 'usage_limited') delete snapshot.usageLimit;
    return this.upsertSnapshot(snapshot, event.message ?? `terminal ${event.status}`);
  }

  setTuiObservedState(
    sessionId: SessionId,
    state: AgentObservedState,
    summary: string,
    detail?: string,
    autoApprovesPermissions?: boolean,
    interactive?: InteractiveAgentProjection
  ): ObservedAgentSnapshot {
    const existing = this.snapshots.get(sessionId);
    const snapshot: ObservedAgentSnapshot = {
      ...(existing ?? {
        id: sessionId,
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'terminal',
        sessionId
      }),
      state,
      lastEventAt: new Date().toISOString(),
      ...(autoApprovesPermissions === undefined ? {} : { autoApprovesPermissions }),
      interactive: interactive ?? projectionForLegacyTransition(existing?.interactive, state)
    };
    if (state !== 'usage_limited') delete snapshot.usageLimit;
    this.snapshots.set(sessionId, snapshot);
    this.appendEventInternal({
      subjectId: sessionId,
      subjectKind: snapshot.subjectKind,
      state,
      summary,
      detail
    });
    this.emit('snapshot', snapshot);
    this.emit('commit');
    return snapshot;
  }

  applyTuiInteractiveEvent(
    sessionId: SessionId,
    event: InteractiveAgentEvent,
    state: AgentObservedState,
    summary: string,
    detail?: string
  ): ObservedAgentSnapshot {
    const existing = this.snapshots.get(sessionId);
    const hadDegradedAttention = existing?.interactive?.observation === 'degraded'
      && existing.interactive.attention.kind !== 'none';
    const current = {
      ...(existing?.interactive ?? projectionFromLegacyState(existing?.state)),
      observation: 'exact' as const
    };
    const reduced = reduceInteractiveAgentProjection(current, event);
    // Cursor has no native permission-request hook. If its PTY parser found an
    // approval, exact lifecycle/tool hooks must not relabel that attention as
    // exact until an event actually resolves or replaces it.
    const preservesDegradedAttention = hadDegradedAttention
      && reduced.attention.kind !== 'none'
      && event.type !== 'approval.requested'
      && event.type !== 'input.requested';
    const interactive = preservesDegradedAttention
      ? { ...reduced, observation: 'degraded' as const }
      : reduced;
    return this.setTuiObservedState(sessionId, state, summary, detail, undefined, interactive);
  }

  setTuiUsageLimit(sessionId: SessionId, usageLimit: AgentUsageLimit): ObservedAgentSnapshot {
    const existing = this.snapshots.get(sessionId);
    const snapshot: ObservedAgentSnapshot = {
      ...(existing ?? {
        id: sessionId,
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider: 'terminal',
        sessionId
      }),
      state: 'usage_limited',
      usageLimit,
      interactive: reduceInteractiveAgentProjection(
        existing?.interactive ?? projectionFromLegacyState(existing?.state),
        {
          type: 'usage.limited',
          summary: usageLimit.message,
          occurredAt: usageLimit.detectedAt
        }
      ),
      lastEventAt: usageLimit.detectedAt
    };
    this.snapshots.set(sessionId, snapshot);
    this.appendEventInternal({
      subjectId: sessionId,
      subjectKind: snapshot.subjectKind,
      state: 'usage_limited',
      summary: usageLimit.resetAtLabel
        ? `usage limit until ${usageLimit.resetAtLabel}`
        : 'usage limit reached',
      detail: usageLimit.message
    });
    this.emit('snapshot', snapshot);
    this.emit('commit');
    return snapshot;
  }

  updateTuiProviderThread(
    sessionId: SessionId,
    provider: 'claude_code' | 'codex' | 'cursor',
    providerThreadId?: string
  ): ObservedAgentSnapshot {
    const existing = this.snapshots.get(sessionId);
    const snapshot: ObservedAgentSnapshot = {
      ...(existing ?? {
        id: sessionId,
        runtimeMode: 'tui',
        subjectKind: 'session',
        provider,
        sessionId,
        state: 'idle'
      }),
      provider,
      ...(providerThreadId ? { providerThreadId } : {}),
      lastEventAt: new Date().toISOString()
    };
    return this.upsertSnapshot(snapshot, 'provider session bound');
  }

  registerWorker(input: {
    workerId: string;
    originSessionId: SessionId;
    provider: 'claude_code' | 'codex' | 'cursor';
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
    patch: Partial<Omit<ObservedAgentSnapshot, 'id' | 'runtimeMode' | 'subjectKind' | 'workerId'>>,
    event?: { summary: string; detail?: string }
  ): ObservedAgentSnapshot {
    const existing = this.snapshots.get(workerId);
    if (!existing || existing.subjectKind !== 'worker') {
      throw new Error(`Worker not found: ${workerId}`);
    }
    const snapshot: ObservedAgentSnapshot = {
      ...existing,
      ...patch,
      id: workerId,
      runtimeMode: 'sdk_worker',
      subjectKind: 'worker',
      workerId,
      lastEventAt: patch.lastEventAt ?? new Date().toISOString()
    };
    if (!event) return this.upsertSnapshot(snapshot);
    // Worker runtime updates historically publish snapshot before event.
    // Preserve that outward ordering while committing the pair once.
    this.snapshots.set(workerId, snapshot);
    this.emit('snapshot', snapshot);
    this.appendEventInternal({
      subjectId: workerId,
      subjectKind: 'worker',
      state: snapshot.state,
      summary: event.summary,
      detail: event.detail,
      autoApprovesPermissions: snapshot.autoApprovesPermissions
    });
    this.emit('commit');
    return snapshot;
  }

  appendEvent(input: {
    subjectId: string;
    subjectKind: ObserverSubjectKind;
    state: AgentObservedState;
    summary: string;
    detail?: string;
    autoApprovesPermissions?: boolean;
  }): ObserverEvent {
    const event = this.appendEventInternal(input);
    this.emit('commit');
    return event;
  }

  private appendEventInternal(input: {
    subjectId: string;
    subjectKind: ObserverSubjectKind;
    state: AgentObservedState;
    summary: string;
    detail?: string;
    autoApprovesPermissions?: boolean;
  }): ObserverEvent {
    const autoApprovesPermissions = input.autoApprovesPermissions
      ?? this.snapshots.get(input.subjectId)?.autoApprovesPermissions;
    const event: ObserverEvent = {
      id: `evt-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      subjectId: input.subjectId,
      subjectKind: input.subjectKind,
      timestamp: new Date().toISOString(),
      state: input.state,
      summary: input.summary,
      detail: input.detail,
      ...(autoApprovesPermissions === undefined ? {} : { autoApprovesPermissions })
    };
    this.eventOrder.set(event, this.nextEventOrder++);
    const list = this.eventsBySubject.get(input.subjectId) ?? [];
    list.push(event);
    if (list.length > this.maxEventsPerSubject) {
      list.splice(0, list.length - this.maxEventsPerSubject);
    }
    this.eventsBySubject.set(input.subjectId, list);
    this.emit('event', event);
    return event;
  }

  setAutoApprovesPermissions(
    subjectId: string,
    autoApprovesPermissions: boolean
  ): ObservedAgentSnapshot | null {
    const existing = this.snapshots.get(subjectId);
    if (!existing || existing.autoApprovesPermissions === autoApprovesPermissions) {
      return existing ?? null;
    }
    const snapshot: ObservedAgentSnapshot = {
      ...existing,
      autoApprovesPermissions
    };
    this.snapshots.set(subjectId, snapshot);
    this.emit('snapshot', snapshot);
    this.emit('commit');
    return snapshot;
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
    const sorted = events.sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp)
      || (this.eventOrder.get(b) ?? 0) - (this.eventOrder.get(a) ?? 0)
    );
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
      this.appendEventInternal({
        subjectId: snapshot.id,
        subjectKind: snapshot.subjectKind,
        state: snapshot.state,
        summary: eventSummary
      });
    }
    this.emit('snapshot', snapshot);
    this.emit('commit');
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

function projectionFromLegacyState(
  state: AgentObservedState | undefined
): InteractiveAgentProjection {
  const projection = initialInteractiveAgentProjection('degraded');
  switch (state) {
    case 'starting':
      return projection;
    case 'working':
      return { ...projection, lifecycle: 'running', turn: 'working' };
    case 'running_tool':
      return { ...projection, lifecycle: 'running', turn: 'running_tool' };
    case 'waiting_for_approval':
      return {
        ...projection,
        lifecycle: 'running',
        attention: { kind: 'approval' }
      };
    case 'waiting_for_input':
      return {
        ...projection,
        lifecycle: 'running',
        attention: { kind: 'user_input' }
      };
    case 'usage_limited':
      return {
        ...projection,
        lifecycle: 'running',
        attention: { kind: 'usage_limit' }
      };
    case 'failed':
      return {
        ...projection,
        lifecycle: 'failed',
        attention: { kind: 'error' }
      };
    case 'exited':
      return { ...projection, lifecycle: 'exited' };
    case 'idle':
    case 'completed':
    case undefined:
      return { ...projection, lifecycle: 'running' };
  }
}

function projectionForLegacyTransition(
  current: InteractiveAgentProjection | undefined,
  state: AgentObservedState
): InteractiveAgentProjection {
  const projection = current ?? initialInteractiveAgentProjection('degraded');
  const lastEventAt = new Date().toISOString();
  const base = { ...projection, observation: 'degraded' as const, lastEventAt };
  switch (state) {
    case 'starting':
      return {
        ...base,
        lifecycle: 'starting',
        turn: 'idle',
        attention: { kind: 'none' },
        tool: undefined
      };
    case 'working':
      return {
        ...base,
        lifecycle: 'running',
        turn: 'working',
        attention: { kind: 'none' },
        tool: undefined
      };
    case 'running_tool':
      return {
        ...base,
        lifecycle: 'running',
        turn: 'running_tool',
        attention: { kind: 'none' }
      };
    case 'waiting_for_approval':
      return {
        ...base,
        lifecycle: 'running',
        attention: { kind: 'approval' }
      };
    case 'waiting_for_input':
      return {
        ...base,
        lifecycle: 'running',
        attention: { kind: 'user_input' }
      };
    case 'usage_limited':
      return {
        ...base,
        lifecycle: 'running',
        turn: 'idle',
        attention: { kind: 'usage_limit' },
        tool: undefined
      };
    case 'completed':
    case 'idle':
      return {
        ...base,
        lifecycle: 'running',
        turn: 'idle',
        attention: { kind: 'none' },
        tool: undefined
      };
    case 'failed':
      return {
        ...base,
        lifecycle: 'failed',
        turn: 'idle',
        attention: { kind: 'error' },
        tool: undefined
      };
    case 'exited':
      return {
        ...base,
        lifecycle: 'exited',
        turn: 'idle',
        attention: { kind: 'none' },
        tool: undefined
      };
  }
}

function projectionForTerminalStatus(
  current: InteractiveAgentProjection | undefined,
  status: SessionStatus,
  state: AgentObservedState
): InteractiveAgentProjection {
  const projection = projectionForLegacyTransition(current, state);
  switch (status) {
    case 'starting': return { ...projection, lifecycle: 'starting' };
    case 'running': return { ...projection, lifecycle: 'running' };
    case 'error': return { ...projection, lifecycle: 'failed' };
    case 'exited':
    case 'stopped':
      return { ...projection, lifecycle: 'exited', turn: 'idle', tool: undefined };
  }
}
