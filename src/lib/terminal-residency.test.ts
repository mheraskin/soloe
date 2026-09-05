import { describe, expect, it } from 'vitest';
import {
  TerminalResidency,
  localTerminalPresentationKey
} from './terminal-residency';

describe('TerminalResidency', () => {
  it('keeps visible Sessions first and evicts the least recently visible presentation', () => {
    const residency = new TerminalResidency();
    const livePresentationKeys = ['a', 'b', 'c', 'd'];

    expect(residency.reconcile({ livePresentationKeys, presentedKeys: ['a'], maxResidents: 3 }))
      .toEqual(['a']);
    expect(residency.reconcile({ livePresentationKeys, presentedKeys: ['b'], maxResidents: 3 }))
      .toEqual(['b', 'a']);
    expect(residency.reconcile({ livePresentationKeys, presentedKeys: ['c'], maxResidents: 3 }))
      .toEqual(['c', 'b', 'a']);
    expect(residency.reconcile({ livePresentationKeys, presentedKeys: ['d'], maxResidents: 3 }))
      .toEqual(['d', 'c', 'b']);
  });

  it('retains both Sessions in a split at the supported minimum', () => {
    const residency = new TerminalResidency();

    expect(residency.reconcile({
      livePresentationKeys: ['left', 'right'],
      presentedKeys: ['right', 'left', 'right'],
      maxResidents: 2
    })).toEqual(['right', 'left']);
  });

  it('prunes presentations as soon as their PTY is no longer live', () => {
    const residency = new TerminalResidency();
    residency.reconcile({
      livePresentationKeys: ['a', 'b'],
      presentedKeys: ['a'],
      maxResidents: 3
    });
    residency.reconcile({
      livePresentationKeys: ['a', 'b'],
      presentedKeys: ['b'],
      maxResidents: 3
    });

    expect(residency.reconcile({
      livePresentationKeys: ['b'],
      presentedKeys: ['b'],
      maxResidents: 3
    })).toEqual(['b']);
  });

  it('does not allocate a presentation for a never-visible background Session', () => {
    const residency = new TerminalResidency();

    expect(residency.reconcile({
      livePresentationKeys: ['visible', 'background'],
      presentedKeys: ['visible'],
      maxResidents: 3
    })).toEqual(['visible']);
  });

  it('keeps presentation count constant while cycling through one hundred live Sessions', () => {
    const residency = new TerminalResidency();
    const livePresentationKeys = Array.from({ length: 100 }, (_, index) => `session-${index}`);
    let residents: string[] = [];
    for (const presented of livePresentationKeys) {
      residents = residency.reconcile({
        livePresentationKeys,
        presentedKeys: [presented],
        maxResidents: 3
      });
      expect(residents.length).toBeLessThanOrEqual(3);
    }

    expect(residents).toEqual(['session-99', 'session-98', 'session-97']);
  });

  it('shares one budget across local and remote presentation keys', () => {
    const residency = new TerminalResidency();
    const localA = localTerminalPresentationKey('terminal-a');
    const localB = localTerminalPresentationKey('terminal-b');
    const remoteC = 'device:device-c/session-c:terminal-c';
    const remoteD = 'device:device-d/session-d:terminal-d';
    const livePresentationKeys = [localA, localB, remoteC, remoteD];

    residency.reconcile({ livePresentationKeys, presentedKeys: [localA], maxResidents: 3 });
    residency.reconcile({ livePresentationKeys, presentedKeys: [localB], maxResidents: 3 });
    residency.reconcile({ livePresentationKeys, presentedKeys: [remoteC], maxResidents: 3 });

    expect(residency.reconcile({
      livePresentationKeys,
      presentedKeys: [remoteD],
      maxResidents: 3
    })).toEqual([remoteD, remoteC, localB]);
  });

  it('applies limit changes immediately without losing recency order', () => {
    const residency = new TerminalResidency();
    const livePresentationKeys = ['a', 'b', 'c', 'd', 'e'];
    for (const presented of ['a', 'b', 'c', 'd']) {
      residency.reconcile({ livePresentationKeys, presentedKeys: [presented], maxResidents: 5 });
    }

    expect(residency.reconcile({
      livePresentationKeys,
      presentedKeys: ['d'],
      maxResidents: 2
    })).toEqual(['d', 'c']);
    expect(residency.reconcile({
      livePresentationKeys,
      presentedKeys: ['e'],
      maxResidents: 5
    })).toEqual(['e', 'd', 'c']);
  });
});
