import type {
  InteractiveAgentObservation,
  InteractiveAgentProjection
} from './types/agents.js';

export type InteractiveAgentEvent =
  | { type: 'session.started'; providerSessionId?: string; occurredAt?: string }
  | { type: 'session.ended'; outcome: 'exited' | 'failed'; summary?: string; occurredAt?: string }
  | { type: 'turn.submitted'; providerTurnId?: string; occurredAt?: string }
  | {
      type: 'turn.stopped';
      outcome: 'completed' | 'interrupted' | 'failed';
      summary?: string;
      occurredAt?: string;
    }
  | { type: 'tool.started'; tool: { id?: string; name: string }; occurredAt?: string }
  | { type: 'tool.finished'; occurredAt?: string }
  | {
      type: 'approval.requested';
      requestKey?: string;
      summary?: string;
      occurredAt?: string;
    }
  | {
      type: 'input.requested';
      requestKey?: string;
      summary?: string;
      occurredAt?: string;
    }
  | { type: 'usage.limited'; summary?: string; occurredAt?: string }
  | { type: 'attention.resolved'; occurredAt?: string }
  | { type: 'runtime.failed'; summary?: string; occurredAt?: string };

export function initialInteractiveAgentProjection(
  observation: InteractiveAgentObservation,
  occurredAt = new Date().toISOString()
): InteractiveAgentProjection {
  return {
    lifecycle: 'starting',
    turn: 'idle',
    attention: { kind: 'none' },
    observation,
    lastEventAt: occurredAt
  };
}

export function reduceInteractiveAgentProjection(
  current: InteractiveAgentProjection,
  event: InteractiveAgentEvent
): InteractiveAgentProjection {
  const next: InteractiveAgentProjection = {
    ...current,
    lastEventAt: event.occurredAt ?? new Date().toISOString()
  };

  switch (event.type) {
    case 'session.started':
      return {
        ...next,
        lifecycle: 'running',
        turn: 'idle',
        attention: { kind: 'none' },
        ...(event.providerSessionId ? { providerSessionId: event.providerSessionId } : {})
      };
    case 'session.ended':
      return {
        ...next,
        lifecycle: event.outcome === 'failed' ? 'failed' : 'exited',
        turn: 'idle',
        attention: event.outcome === 'failed'
          ? { kind: 'error', ...(event.summary ? { summary: event.summary } : {}) }
          : { kind: 'none' },
        tool: undefined
      };
    case 'turn.submitted':
      return {
        ...next,
        lifecycle: 'running',
        turn: 'working',
        ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {})
      };
    case 'turn.stopped':
      return {
        ...next,
        turn: 'idle',
        attention: event.outcome === 'failed'
          ? { kind: 'error', ...(event.summary ? { summary: event.summary } : {}) }
          : { kind: 'none' },
        tool: undefined
      };
    case 'tool.started':
      return { ...next, lifecycle: 'running', turn: 'running_tool', tool: event.tool };
    case 'tool.finished':
      return { ...next, turn: 'working', tool: undefined };
    case 'approval.requested':
      return {
        ...next,
        attention: {
          kind: 'approval',
          ...(event.requestKey ? { requestKey: event.requestKey } : {}),
          ...(event.summary ? { summary: event.summary } : {})
        }
      };
    case 'input.requested':
      return {
        ...next,
        attention: {
          kind: 'user_input',
          ...(event.requestKey ? { requestKey: event.requestKey } : {}),
          ...(event.summary ? { summary: event.summary } : {})
        }
      };
    case 'usage.limited':
      return {
        ...next,
        turn: 'idle',
        attention: {
          kind: 'usage_limit',
          ...(event.summary ? { summary: event.summary } : {})
        },
        tool: undefined
      };
    case 'attention.resolved':
      return { ...next, attention: { kind: 'none' } };
    case 'runtime.failed':
      return {
        ...next,
        lifecycle: 'failed',
        turn: 'idle',
        attention: {
          kind: 'error',
          ...(event.summary ? { summary: event.summary } : {})
        },
        tool: undefined
      };
  }
}
