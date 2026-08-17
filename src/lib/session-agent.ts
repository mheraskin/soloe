import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type { AgentRuntimeProvider, Session, SessionLaunchKind } from '@shared/types/sessions.js';
import { launchKind } from '@shared/types/sessions.js';

export function displaySessionKind(
  session: Session,
  observed: Pick<ObservedAgentSnapshot, 'provider'> | null = null
): SessionLaunchKind {
  const observedProvider = observed?.provider;
  if (isAgentProvider(observedProvider)) return observedProvider;
  if (session.currentAgentRuntime?.provider) return session.currentAgentRuntime.provider;
  return launchKind(session);
}

function isAgentProvider(value: unknown): value is AgentRuntimeProvider {
  return value === 'claude_code' || value === 'codex' || value === 'cursor';
}
