import { describe, expect, it } from 'vitest';
import { Keymap } from './keymap';

function keydown(overrides: KeyboardEventInit): KeyboardEvent {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides
  } as KeyboardEvent;
}

describe('browser developer tools keymap', () => {
  it('matches Control-Shift-I', () => {
    expect(Keymap.browserDevTools.match(keydown({ key: 'I', ctrlKey: true, shiftKey: true })))
      .toBe(true);
  });

  it('matches the macOS browser developer tools alternatives', () => {
    expect(Keymap.browserDevTools.match(keydown({ key: 'i', metaKey: true, altKey: true })))
      .toBe(true);
    expect(Keymap.browserDevTools.match(keydown({ key: 'c', metaKey: true, shiftKey: true })))
      .toBe(true);
  });

  it('does not claim partial or extra-modifier shortcuts', () => {
    expect(Keymap.browserDevTools.match(keydown({ key: 'i', ctrlKey: true }))).toBe(false);
    expect(
      Keymap.browserDevTools.match(
        keydown({ key: 'i', ctrlKey: true, shiftKey: true, altKey: true })
      )
    ).toBe(false);
  });
});
