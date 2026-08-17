import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type { AgentObservedState, SessionStatus } from '@shared/types/sessions.js';

export interface DisplayedAgentStateInput {
  observed: Pick<ObservedAgentSnapshot, 'state' | 'interactive'> | null;
  status: SessionStatus;
  hasRuntime: boolean;
  hasNotificationMarker: boolean;
}

export function displayedAgentState(input: DisplayedAgentStateInput): AgentObservedState | null {
  if (!input.observed) return null;
  const normalized = normalizedAgentState(input.observed, input.hasNotificationMarker);
  if (!input.hasRuntime && !isVisibleWithoutRuntime(normalized)) return null;

  if (normalized === 'starting') {
    return input.status === 'running' ? 'idle' : null;
  }

  if (normalized === 'completed' && !input.hasNotificationMarker) {
    return 'idle';
  }

  return normalized;
}

function normalizedAgentState(
  observed: Pick<ObservedAgentSnapshot, 'state' | 'interactive'>,
  hasNotificationMarker: boolean
): AgentObservedState {
  const projection = observed.interactive;
  if (!projection) return observed.state;

  switch (projection.attention.kind) {
    case 'approval': return 'waiting_for_approval';
    case 'user_input': return 'waiting_for_input';
    case 'usage_limit': return 'usage_limited';
    case 'error': return 'failed';
    case 'none': break;
  }
  if (projection.lifecycle === 'failed') return 'failed';
  if (projection.lifecycle === 'exited') return 'exited';
  if (projection.lifecycle === 'starting') return 'starting';
  if (projection.turn === 'running_tool') return 'running_tool';
  if (projection.turn === 'working') return 'working';
  if (observed.state === 'completed' && hasNotificationMarker) return 'completed';
  return 'idle';
}

function isVisibleWithoutRuntime(state: AgentObservedState): boolean {
  return state === 'working'
    || state === 'running_tool'
    || state === 'waiting_for_input'
    || state === 'waiting_for_approval';
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
