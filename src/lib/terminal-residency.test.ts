import { describe, expect, it } from 'vitest';
import { TerminalResidency } from './terminal-residency';

describe('TerminalResidency', () => {
  it('keeps visible Sessions first and evicts the least recently visible presentation', () => {
    const residency = new TerminalResidency(3);
    const liveSessionIds = ['a', 'b', 'c', 'd'];

    expect(residency.reconcile({ liveSessionIds, visibleSessionIds: ['a'] })).toEqual(['a']);
    expect(residency.reconcile({ liveSessionIds, visibleSessionIds: ['b'] })).toEqual(['b', 'a']);
    expect(residency.reconcile({ liveSessionIds, visibleSessionIds: ['c'] })).toEqual(['c', 'b', 'a']);
    expect(residency.reconcile({ liveSessionIds, visibleSessionIds: ['d'] })).toEqual(['d', 'c', 'b']);
  });

  it('always retains every visible split Session even above the configured floor', () => {
    const residency = new TerminalResidency(1);

    expect(residency.reconcile({
      liveSessionIds: ['left', 'right'],
      visibleSessionIds: ['right', 'left', 'right']
    })).toEqual(['right', 'left']);
  });

  it('prunes presentations as soon as their PTY is no longer live', () => {
    const residency = new TerminalResidency(4);
    residency.reconcile({ liveSessionIds: ['a', 'b'], visibleSessionIds: ['a'] });
    residency.reconcile({ liveSessionIds: ['a', 'b'], visibleSessionIds: ['b'] });

    expect(residency.reconcile({ liveSessionIds: ['b'], visibleSessionIds: ['b'] })).toEqual(['b']);
  });

  it('does not allocate a presentation for a never-visible background Session', () => {
    const residency = new TerminalResidency(4);

    expect(residency.reconcile({
      liveSessionIds: ['visible', 'background'],
      visibleSessionIds: ['visible']
    })).toEqual(['visible']);
  });

  it('keeps presentation count constant while cycling through one hundred live Sessions', () => {
    const residency = new TerminalResidency(4);
    const liveSessionIds = Array.from({ length: 100 }, (_, index) => `session-${index}`);
    let residents: string[] = [];
    for (const visible of liveSessionIds) {
      residents = residency.reconcile({ liveSessionIds, visibleSessionIds: [visible] });
      expect(residents.length).toBeLessThanOrEqual(4);
    }

    expect(residents).toEqual(['session-99', 'session-98', 'session-97', 'session-96']);
  });
});
