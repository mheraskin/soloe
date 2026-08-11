import type { ObservedAgentSnapshot, ObserverEvent } from '@shared/types/agents.js';
import { sessionAutoApprovesPermissions } from '@shared/agent-permissions.js';
import type {
  AgentObservedState,
  Session,
  SessionId,
  SessionLaunchKind
} from '@shared/types/sessions.js';
import { launchKind } from '@shared/types/sessions.js';
import { showAgentSystemNotification } from '../lib/agent-system-notifications';

export type NotifyState = Extract<
  AgentObservedState,
  'waiting_for_input' | 'waiting_for_approval' | 'usage_limited' | 'completed' | 'failed'
>;

export interface AgentEdgeMarker {
  sessionId: SessionId;
  subjectId: string;
  state: NotifyState;
  reason: string;
  createdAt: number;
  sequence: number;
}

export interface AgentToastNotice extends AgentEdgeMarker {
  sessionName: string;
  sessionKind: SessionLaunchKind;
  projectId?: string;
  cwd: string;
  runMode: Session['runMode'];
  lastBranch?: string;
}

const COMPLETED_DISMISS_MS = 6000;

const stateUrgency = {
  waiting_for_approval: 4,
  usage_limited: 5,
  waiting_for_input: 3,
  failed: 2,
  completed: 1
} satisfies Record<NotifyState, number>;

class AgentNotificationsStore {
  markers = $state<Record<SessionId, AgentEdgeMarker>>({});
  toasts = $state<AgentToastNotice[]>([]);

  private lastStates = new Map<string, AgentObservedState>();
  private lastEvents = new Map<string, ObserverEvent>();
  private pendingSnapshots = new Map<string, AgentObservedState>();
  private toastTimers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  private sequence = 0;

  pulsingSessionId = $derived.by<SessionId | null>(() => {
    const markers = Object.values(this.markers);
    if (markers.length === 0) return null;
    markers.sort((a, b) => {
      const urgencyDelta = stateUrgency[b.state] - stateUrgency[a.state];
      if (urgencyDelta !== 0) return urgencyDelta;
      return b.sequence - a.sequence;
    });
    return markers[0]?.sessionId ?? null;
  });

  markerFor(sessionId: SessionId): AgentEdgeMarker | null {
    return this.markers[sessionId] ?? null;
  }

  rememberEvent(event: ObserverEvent): void {
    this.log('remember event', {
      subjectId: event.subjectId,
      subjectKind: event.subjectKind,
      state: event.state,
      summary: event.summary
    });
    this.lastEvents.set(event.subjectId, event);
  }

  primeSnapshot(
    snapshot: ObservedAgentSnapshot,
    session: Session | null,
    activeSessionId: SessionId | null
  ): void {
    const rowSessionId = rowSessionIdFor(snapshot);
    this.log('prime snapshot', {
      subjectId: snapshot.id,
      rowSessionId,
      state: snapshot.state,
      sessionId: session?.id ?? null,
      activeSessionId
    });
    this.lastStates.set(snapshot.id, snapshot.state);
    if (!rowSessionId || !session || !isNotifyState(snapshot.state)) return;
    if (
      snapshot.state === 'waiting_for_approval'
      && approvalsAreAutomatic(session, snapshot.autoApprovesPermissions)
    ) {
      this.clearSubject(rowSessionId, snapshot.id);
      return;
    }
    if (rowSessionId === activeSessionId) return;
    this.setMarker(rowSessionId, snapshot.id, snapshot.state, reasonFor(snapshot, null));
  }

  observeSnapshot(
    snapshot: ObservedAgentSnapshot,
    session: Session | null,
    activeSessionId: SessionId | null,
    isAppFocused = false
  ): void {
    const rowSessionId = rowSessionIdFor(snapshot);
    const reason = reasonFor(snapshot, this.lastEvents.get(snapshot.id) ?? null);
    const pendingState = this.pendingSnapshots.get(snapshot.id);
    this.pendingSnapshots.delete(snapshot.id);
    this.log('observe snapshot', {
      subjectId: snapshot.id,
      rowSessionId,
      state: snapshot.state,
      reason,
      sessionId: session?.id ?? null,
      activeSessionId
    });
    if (pendingState === snapshot.state) {
      this.log('skip matching snapshot already handled by event', {
        subjectId: snapshot.id,
        state: snapshot.state
      });
      return;
    }
    this.trackState({
      subjectId: snapshot.id,
      rowSessionId,
      state: snapshot.state,
      reason,
      session,
      autoApprovesPermissions: snapshot.autoApprovesPermissions,
      activeSessionId,
      isAppFocused
    });
  }

  observeEvent(
    event: ObserverEvent,
    session: Session | null,
    activeSessionId: SessionId | null,
    rowSessionId: SessionId | null,
    isAppFocused = false
  ): void {
    this.rememberEvent(event);
    this.pendingSnapshots.set(event.subjectId, event.state);
    this.log('observe event', {
      subjectId: event.subjectId,
      rowSessionId,
      state: event.state,
      summary: event.summary,
      sessionId: session?.id ?? null,
      activeSessionId
    });
    this.trackState({
      subjectId: event.subjectId,
      rowSessionId,
      state: event.state,
      reason: event.summary,
      session,
      autoApprovesPermissions: event.autoApprovesPermissions,
      activeSessionId,
      isAppFocused
    });
  }

  acknowledge(sessionId: SessionId): void {
    this.log('acknowledge', { sessionId });
    if (this.markers[sessionId]) {
      const next = { ...this.markers };
      delete next[sessionId];
      this.markers = next;
    }
    this.dismissToast(sessionId);
  }

  markSessionOpened(sessionId: SessionId): void {
    this.acknowledge(sessionId);
  }

  removeSession(sessionId: SessionId): void {
    this.acknowledge(sessionId);
  }

  reset(): void {
    for (const timer of this.toastTimers.values()) clearTimeout(timer);
    this.toastTimers.clear();
    this.lastStates.clear();
    this.lastEvents.clear();
    this.pendingSnapshots.clear();
    this.markers = {};
    this.toasts = [];
    this.sequence = 0;
  }

  dismissToast(sessionId: SessionId): void {
    this.log('dismiss toast', { sessionId });
    const timer = this.toastTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.toastTimers.delete(sessionId);
    }
    this.toasts = this.toasts.filter((toast) => toast.sessionId !== sessionId);
  }

  private trackState(opts: {
    subjectId: string;
    rowSessionId: SessionId | null;
    state: AgentObservedState;
    reason: string;
    session: Session | null;
    autoApprovesPermissions?: boolean;
    activeSessionId: SessionId | null;
    isAppFocused: boolean;
  }): void {
    const previous = this.lastStates.get(opts.subjectId);
    this.lastStates.set(opts.subjectId, opts.state);

    this.log('track state', {
      subjectId: opts.subjectId,
      rowSessionId: opts.rowSessionId,
      previous,
      state: opts.state,
      activeSessionId: opts.activeSessionId,
      hasSession: Boolean(opts.session)
    });

    if (!opts.rowSessionId) {
      this.log('skip notification: no row session id', { subjectId: opts.subjectId });
      return;
    }

    if (
      opts.state === 'waiting_for_approval'
      && approvalsAreAutomatic(opts.session, opts.autoApprovesPermissions)
    ) {
      this.log('suppress notification: session auto-approves permissions', {
        rowSessionId: opts.rowSessionId,
        subjectId: opts.subjectId
      });
      this.clearSubject(opts.rowSessionId, opts.subjectId);
      return;
    }

    if (!isNotifyState(opts.state)) {
      this.log('clear notification: non-notify state', {
        rowSessionId: opts.rowSessionId,
        subjectId: opts.subjectId,
        state: opts.state
      });
      this.clearSubject(opts.rowSessionId, opts.subjectId);
      return;
    }

    if (opts.rowSessionId === opts.activeSessionId && opts.isAppFocused) {
      this.log('suppress notification: active session is focused', {
        rowSessionId: opts.rowSessionId,
        state: opts.state
      });
      this.acknowledge(opts.rowSessionId);
      return;
    }

    if (opts.rowSessionId === opts.activeSessionId && previous === opts.state) {
      this.log('acknowledge active repeated notify state', {
        rowSessionId: opts.rowSessionId,
        state: opts.state
      });
      this.acknowledge(opts.rowSessionId);
      return;
    }

    const marker = this.setMarker(
      opts.rowSessionId,
      opts.subjectId,
      opts.state,
      opts.reason
    );

    if (previous === opts.state || !opts.session) return;
    this.log('upsert toast', {
      rowSessionId: opts.rowSessionId,
      subjectId: opts.subjectId,
      state: opts.state,
      reason: marker.reason,
      previous,
      hasSession: Boolean(opts.session)
    });
    this.upsertToast({
      ...marker,
      sessionName: opts.session.name || '(unnamed)',
      sessionKind: launchKind(opts.session),
      projectId: opts.session.projectId,
      cwd: opts.session.cwd,
      runMode: opts.session.runMode,
      lastBranch: opts.session.lastBranch
    });
  }

  private setMarker(
    sessionId: SessionId,
    subjectId: string,
    state: NotifyState,
    reason: string
  ): AgentEdgeMarker {
    const marker: AgentEdgeMarker = {
      sessionId,
      subjectId,
      state,
      reason: shortReason(reason, state),
      createdAt: Date.now(),
      sequence: ++this.sequence
    };
    this.log('set marker', marker);
    this.markers = { ...this.markers, [sessionId]: marker };
    return marker;
  }

  private clearSubject(sessionId: SessionId, subjectId: string): void {
    this.log('clear subject', { sessionId, subjectId });
    if (this.markers[sessionId]?.subjectId === subjectId) {
      const next = { ...this.markers };
      delete next[sessionId];
      this.markers = next;
    }
    const toast = this.toasts.find((item) => item.sessionId === sessionId);
    if (toast?.subjectId === subjectId) this.dismissToast(sessionId);
  }

  private upsertToast(toast: AgentToastNotice): void {
    this.log('show toast', toast);
    this.dismissToast(toast.sessionId);
    this.toasts = [...this.toasts, toast];
    void showAgentSystemNotification(toast).catch((error) => {
      this.log('failed to show system notification', error);
    });
    if (toast.state !== 'completed') return;
    const timer = setTimeout(() => {
      this.dismissToast(toast.sessionId);
    }, COMPLETED_DISMISS_MS);
    this.toastTimers.set(toast.sessionId, timer);
  }

  private log(message: string, detail?: unknown): void {
    console.info(`[agent-notifications:renderer] ${message}`, detail ?? '');
  }
}

function approvalsAreAutomatic(
  session: Session | null,
  autoApprovesPermissions?: boolean
): boolean {
  return autoApprovesPermissions === true
    || (session ? sessionAutoApprovesPermissions(session) : false);
}

export const agentNotifications = new AgentNotificationsStore();
export { AgentNotificationsStore };

export function isNotifyState(state: AgentObservedState): state is NotifyState {
  return (
    state === 'waiting_for_input'
    || state === 'waiting_for_approval'
    || state === 'usage_limited'
    || state === 'completed'
    || state === 'failed'
  );
}

export function rowSessionIdFor(snapshot: ObservedAgentSnapshot): SessionId | null {
  if (snapshot.subjectKind === 'worker') {
    return snapshot.originSessionId ?? snapshot.sessionId ?? null;
  }
  return snapshot.sessionId ?? snapshot.id;
}

function reasonFor(snapshot: ObservedAgentSnapshot, event: ObserverEvent | null): string {
  if (event?.state === snapshot.state && event.summary) return event.summary;
  if (snapshot.state === 'failed' && snapshot.error) return snapshot.error;
  if (snapshot.state === 'usage_limited' && snapshot.usageLimit?.message) {
    return snapshot.usageLimit.resetAtLabel
      ? `usage limit until ${snapshot.usageLimit.resetAtLabel}`
      : snapshot.usageLimit.message;
  }
  if (snapshot.resultSummary) return snapshot.resultSummary;
  if (snapshot.promptSummary) return snapshot.promptSummary;
  return defaultReason(snapshot.state);
}

function defaultReason(state: AgentObservedState): string {
  switch (state) {
    case 'waiting_for_input':
      return 'waiting for input';
    case 'waiting_for_approval':
      return 'waiting for approval';
    case 'usage_limited':
      return 'usage limit reached';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'running_tool':
      return 'running tool';
    case 'working':
      return 'thinking';
    case 'starting':
      return 'starting';
    case 'idle':
      return 'idle';
    case 'exited':
      return 'exited';
  }
}

function shortReason(reason: string, state: NotifyState): string {
  const normalized = reason.trim() || defaultReason(state);
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}
