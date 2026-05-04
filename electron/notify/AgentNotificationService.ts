import type { ObservedAgentSnapshot, ObserverEvent } from '@shared/types/agents.js';
import type { AgentObservedState, Session, SessionId, SessionKind } from '@shared/types/sessions.js';
import type { AgentObserverManager } from '../agents/AgentObserverManager.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { Notifier } from './Notifier.js';

type NativeAgentState = Extract<
  AgentObservedState,
  'waiting_for_input' | 'waiting_for_approval' | 'completed' | 'failed'
>;

export interface AgentNotificationServiceOptions {
  observer: AgentObserverManager;
  sessionStore: SessionStore;
  notifier: Pick<Notifier, 'native'>;
}

export class AgentNotificationService {
  private readonly lastStates = new Map<string, AgentObservedState>();
  private readonly lastEvents = new Map<string, ObserverEvent>();
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly opts: AgentNotificationServiceOptions) {}

  attach(): void {
    const onEvent = (event: ObserverEvent) => this.onEvent(event);
    const onSnapshot = (snapshot: ObservedAgentSnapshot) => {
      void this.onSnapshot(snapshot).catch((err) => {
        console.warn('[agent-notifications:main] native notification failed', err);
      });
    };
    this.opts.observer.on('event', onEvent);
    this.opts.observer.on('snapshot', onSnapshot);
    this.listeners.push(
      () => this.opts.observer.off('event', onEvent),
      () => this.opts.observer.off('snapshot', onSnapshot)
    );
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.lastStates.clear();
    this.lastEvents.clear();
  }

  private onEvent(event: ObserverEvent): void {
    this.lastEvents.set(event.subjectId, event);
    console.info('[agent-notifications:main] observer event', {
      subjectId: event.subjectId,
      subjectKind: event.subjectKind,
      state: event.state,
      summary: event.summary
    });
  }

  private async onSnapshot(snapshot: ObservedAgentSnapshot): Promise<void> {
    const previous = this.lastStates.get(snapshot.id);
    this.lastStates.set(snapshot.id, snapshot.state);
    const rowSessionId = rowSessionIdFor(snapshot);
    console.info('[agent-notifications:main] observer snapshot', {
      subjectId: snapshot.id,
      rowSessionId,
      previous,
      state: snapshot.state
    });

    if (!rowSessionId) {
      console.info('[agent-notifications:main] skipped native notification: no row session id');
      return;
    }
    if (!isNativeAgentState(snapshot.state)) {
      console.info('[agent-notifications:main] skipped native notification: non-notify state', {
        state: snapshot.state
      });
      return;
    }
    if (previous === snapshot.state) {
      console.info('[agent-notifications:main] skipped native notification: duplicate state', {
        state: snapshot.state
      });
      return;
    }

    const session = await this.opts.sessionStore.get(rowSessionId);
    const notice = buildNativeNotice(
      snapshot as ObservedAgentSnapshot & { state: NativeAgentState },
      session,
      this.lastEvents.get(snapshot.id) ?? null
    );
    console.info('[agent-notifications:main] showing native notification', {
      rowSessionId,
      state: snapshot.state,
      title: notice.title,
      body: notice.body
    });
    this.opts.notifier.native(notice);
  }
}

function isNativeAgentState(state: AgentObservedState): state is NativeAgentState {
  return (
    state === 'waiting_for_input'
    || state === 'waiting_for_approval'
    || state === 'completed'
    || state === 'failed'
  );
}

function rowSessionIdFor(snapshot: ObservedAgentSnapshot): SessionId | null {
  if (snapshot.subjectKind === 'worker') {
    return snapshot.originSessionId ?? snapshot.sessionId ?? null;
  }
  return snapshot.sessionId ?? snapshot.id;
}

function buildNativeNotice(
  snapshot: ObservedAgentSnapshot & { state: NativeAgentState },
  session: Session | null,
  event: ObserverEvent | null
): { title: string; body: string } {
  const sessionName = session?.name || '(unnamed)';
  const provider = providerLabel(session?.kind ?? snapshot.provider);
  return {
    title: `${provider} ${titleSuffix(snapshot.state)}`,
    body: `${sessionName}: ${reasonFor(snapshot, event)}`
  };
}

function titleSuffix(state: NativeAgentState): string {
  switch (state) {
    case 'waiting_for_input':
      return 'needs input';
    case 'waiting_for_approval':
      return 'needs approval';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
  }
}

function reasonFor(
  snapshot: ObservedAgentSnapshot & { state: NativeAgentState },
  event: ObserverEvent | null
): string {
  if (event?.state === snapshot.state && event.summary) return event.summary;
  if (snapshot.state === 'failed' && snapshot.error) return snapshot.error;
  if (snapshot.resultSummary) return snapshot.resultSummary;
  if (snapshot.promptSummary) return snapshot.promptSummary;
  return titleSuffix(snapshot.state);
}

function providerLabel(provider: SessionKind | ObservedAgentSnapshot['provider']): string {
  if (provider === 'claude_code') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Agent';
}
