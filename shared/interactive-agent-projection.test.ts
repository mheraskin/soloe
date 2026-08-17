import { describe, expect, it } from 'vitest';
import {
  initialInteractiveAgentProjection,
  reduceInteractiveAgentProjection
} from './interactive-agent-projection.js';

describe('interactive agent projection', () => {
  it('keeps approval attention while tool activity continues', () => {
    const approval = reduceInteractiveAgentProjection(
      initialInteractiveAgentProjection('exact'),
      { type: 'approval.requested', summary: 'approval: Shell', requestKey: 'tool-1' }
    );
    const active = reduceInteractiveAgentProjection(approval, {
      type: 'tool.started',
      tool: { id: 'tool-1', name: 'Shell' }
    });

    expect(active.turn).toBe('running_tool');
    expect(active.attention).toEqual({
      kind: 'approval',
      requestKey: 'tool-1',
      summary: 'approval: Shell'
    });
  });

  it('projects lifecycle independently from idle turn state', () => {
    const running = reduceInteractiveAgentProjection(
      initialInteractiveAgentProjection('exact'),
      { type: 'session.started', providerSessionId: 'provider-1' }
    );
    const stopped = reduceInteractiveAgentProjection(running, {
      type: 'session.ended', outcome: 'exited'
    });

    expect(running).toMatchObject({ lifecycle: 'running', turn: 'idle' });
    expect(stopped).toMatchObject({ lifecycle: 'exited', turn: 'idle' });
  });

  it('clears attention only on an explicit resolution event', () => {
    const waiting = reduceInteractiveAgentProjection(
      initialInteractiveAgentProjection('degraded'),
      { type: 'input.requested', summary: 'answer required' }
    );
    const working = reduceInteractiveAgentProjection(waiting, { type: 'turn.submitted' });
    const resolved = reduceInteractiveAgentProjection(working, { type: 'attention.resolved' });

    expect(working.attention.kind).toBe('user_input');
    expect(resolved.attention).toEqual({ kind: 'none' });
  });
});
