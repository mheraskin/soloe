import type { AgentObservedState } from '@shared/types/sessions.js';

export function isCollapsedSessionWorking(state: AgentObservedState): boolean {
  return state === 'starting' || state === 'working' || state === 'running_tool';
}
