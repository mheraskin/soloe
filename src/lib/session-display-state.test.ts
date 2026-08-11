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

  it('keeps approval visible after its notification marker is cleared', () => {
    expect(
      displayedAgentState({
        observed: { state: 'waiting_for_approval' },
        status: 'running',
        hasRuntime: true,
        hasNotificationMarker: false
      })
    ).toBe('waiting_for_approval');
  });

  it('keeps approval visible for attached agents without a renderer runtime row', () => {
    expect(
      displayedAgentState({
        observed: { state: 'waiting_for_approval' },
        status: 'stopped',
        hasRuntime: false,
        hasNotificationMarker: false
      })
    ).toBe('waiting_for_approval');
  });

  it('keeps input visible after its notification marker is cleared', () => {
    expect(
      displayedAgentState({
        observed: { state: 'waiting_for_input' },
        status: 'running',
        hasRuntime: true,
        hasNotificationMarker: false
      })
    ).toBe('waiting_for_input');
  });

  it('keeps input visible for attached agents without a renderer runtime row', () => {
    expect(
      displayedAgentState({
        observed: { state: 'waiting_for_input' },
        status: 'stopped',
        hasRuntime: false,
        hasNotificationMarker: false
      })
    ).toBe('waiting_for_input');
  });

  it.each(['working', 'running_tool'] as const)(
    'keeps %s visible for attached agents without a renderer runtime row',
    (state) => {
      expect(
        displayedAgentState({
          observed: { state },
          status: 'stopped',
          hasRuntime: false,
          hasNotificationMarker: false
        })
      ).toBe(state);
    }
  );

  it('uses an idle summary when a transient state is displayed as idle', () => {
    expect(displayedAgentSummary({ state: 'completed' }, 'idle', 'done')).toBe('idle');
  });
});
