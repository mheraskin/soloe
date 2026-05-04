import { describe, expect, it } from 'vitest';
import { displayedAgentState, displayedAgentSummary } from './session-display-state';

describe('session display state', () => {
  it('hides observed state when a saved session has no runtime', () => {
    expect(
      displayedAgentState({
        observed: { state: 'idle' },
        status: 'stopped',
        hasRuntime: false,
        hasNotificationMarker: false
      })
    ).toBeNull();
  });

  it('keeps completed visible while the done marker is unacknowledged', () => {
    expect(
      displayedAgentState({
        observed: { state: 'completed' },
        status: 'running',
        hasRuntime: true,
        hasNotificationMarker: true
      })
    ).toBe('completed');
  });

  it('shows completed sessions as idle after acknowledgement', () => {
    expect(
      displayedAgentState({
        observed: { state: 'completed' },
        status: 'running',
        hasRuntime: true,
        hasNotificationMarker: false
      })
    ).toBe('idle');
  });

  it('uses an idle summary when a transient state is displayed as idle', () => {
    expect(displayedAgentSummary({ state: 'completed' }, 'idle', 'done')).toBe('idle');
  });
});
