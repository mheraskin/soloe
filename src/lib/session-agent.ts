import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type { AgentRuntimeProvider, Session, SessionKind } from '@shared/types/sessions.js';

export function displaySessionKind(
  session: Session,
  observed: Pick<ObservedAgentSnapshot, 'provider'> | null = null
): SessionKind {
  const observedProvider = observed?.provider;
  if (isAgentProvider(observedProvider)) return observedProvider;
  if (session.currentAgentRuntime?.provider) return session.currentAgentRuntime.provider;
  return session.kind;
}

function isAgentProvider(value: unknown): value is AgentRuntimeProvider {
  return value === 'claude_code' || value === 'codex';
}
