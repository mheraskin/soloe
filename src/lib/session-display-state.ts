import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type { AgentObservedState, SessionStatus } from '@shared/types/sessions.js';

export interface DisplayedAgentStateInput {
  observed: Pick<ObservedAgentSnapshot, 'state'> | null;
  status: SessionStatus;
  hasRuntime: boolean;
  hasNotificationMarker: boolean;
}

export function displayedAgentState(input: DisplayedAgentStateInput): AgentObservedState | null {
  if (!input.observed) return null;
  if (!input.hasRuntime && !isActionableState(input.observed.state)) return null;

  if (input.observed.state === 'starting') {
    return input.status === 'running' ? 'idle' : null;
  }

  if (input.observed.state === 'completed' && !input.hasNotificationMarker) {
    return 'idle';
  }

  return input.observed.state;
}

function isActionableState(state: AgentObservedState): boolean {
  return state === 'waiting_for_input' || state === 'waiting_for_approval';
}

export function displayedAgentSummary(
  observed: Pick<ObservedAgentSnapshot, 'state'> | null,
  state: AgentObservedState | null,
  summary: string | null
): string | null {
  if (!state) return null;
  if (state === 'idle' && observed?.state !== 'idle') return 'idle';
  return summary;
}
