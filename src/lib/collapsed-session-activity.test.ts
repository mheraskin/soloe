import { describe, expect, it } from 'vitest';
import type { AgentObservedState } from '@shared/types/sessions.js';
import { isCollapsedSessionWorking } from './collapsed-session-activity';

describe('isCollapsedSessionWorking', () => {
  it.each(['starting', 'working', 'running_tool'] satisfies AgentObservedState[])(
    'treats %s as active work',
    (state) => {
      expect(isCollapsedSessionWorking(state)).toBe(true);
    }
  );

  it.each([
    'idle',
    'waiting_for_input',
    'waiting_for_approval',
    'usage_limited',
    'completed',
    'failed',
    'exited'
  ] satisfies AgentObservedState[])('does not animate %s', (state) => {
    expect(isCollapsedSessionWorking(state)).toBe(false);
  });
});
