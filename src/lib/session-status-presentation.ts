import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type {
  AgentObservedState,
  Session,
  SessionStatus
} from '@shared/types/sessions.js';
import { isCollapsedSessionWorking } from './collapsed-session-activity';
import { displayedAgentState, displayedAgentSummary } from './session-display-state';

export type SessionStatusTone = 'active' | 'done' | 'issue';

export interface SessionStatusDot {
  tone: SessionStatusTone;
  title: string;
}

export interface SessionStatusPresentationInput {
  session: Session;
  status: SessionStatus;
  observed: ObservedAgentSnapshot | null;
  observedSummary: string | null;
  hasRuntime: boolean;
  hasNotificationMarker: boolean;
}

export interface SessionStatusPresentation {
  agentState: AgentObservedState | null;
  agentSummary: string | null;
  statusDot: SessionStatusDot | null;
  working: boolean;
}

export function sessionStatusPresentation(
  input: SessionStatusPresentationInput
): SessionStatusPresentation {
  if (!input.hasRuntime && (input.status === 'exited' || input.status === 'error')) {
    const tone = runtimeStatusTone(input.status)!;
    return {
      agentState: null,
      agentSummary: null,
      statusDot: { tone, title: stateLabel(input.status) },
      working: false
    };
  }
  const agentState = displayedAgentState({
    observed: input.observed,
    status: input.status,
    hasRuntime: input.hasRuntime,
    hasNotificationMarker: input.hasNotificationMarker
  });
  const agentSummary = displayedAgentSummary(
    input.observed,
    agentState,
    input.observedSummary
  );

  if (input.observed?.state === 'completed' || input.observed?.state === 'exited') {
    return {
      agentState,
      agentSummary,
      statusDot: {
        tone: 'done',
        title: statusTitle(stateLabel(input.observed.state), input.observedSummary)
      },
      working: false
    };
  }
  if (input.observed?.state === 'failed' || input.observed?.state === 'waiting_for_approval') {
    return {
      agentState,
      agentSummary,
      statusDot: {
        tone: 'issue',
        title: statusTitle(stateLabel(input.observed.state), input.observedSummary)
      },
      working: false
    };
  }

  if (agentState) {
    if (isCollapsedSessionWorking(agentState)) {
      return { agentState, agentSummary, statusDot: null, working: true };
    }
    return {
      agentState,
      agentSummary,
      statusDot: {
        tone: agentStateTone(agentState),
        title: statusTitle(stateLabel(agentState), agentSummary)
      },
      working: false
    };
  }

  if (input.status === 'starting' && isAgentSession(input.session, input.observed)) {
    return { agentState: null, agentSummary: null, statusDot: null, working: true };
  }

  const tone = runtimeStatusTone(input.status);
  return {
    agentState: null,
    agentSummary: null,
    statusDot: tone ? { tone, title: stateLabel(input.status) } : null,
    working: false
  };
}

function isAgentSession(session: Session, observed: ObservedAgentSnapshot | null): boolean {
  return session.launch.type === 'agent'
    || observed?.provider === 'claude_code'
    || observed?.provider === 'codex'
    || observed?.provider === 'cursor';
}

function agentStateTone(state: AgentObservedState): SessionStatusTone {
  if (state === 'completed' || state === 'exited') return 'done';
  if (state === 'failed' || state === 'waiting_for_approval') return 'issue';
  return 'active';
}

function runtimeStatusTone(status: SessionStatus): SessionStatusTone | null {
  if (status === 'running' || status === 'starting') return 'active';
  if (status === 'exited') return 'done';
  if (status === 'error') return 'issue';
  return null;
}

function statusTitle(label: string, summary: string | null): string {
  return summary ? `${label} · ${summary}` : label;
}

function stateLabel(state: AgentObservedState | SessionStatus): string {
  return state.replaceAll('_', ' ');
}
