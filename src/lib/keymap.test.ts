import { describe, expect, it } from 'vitest';
import {
  Keymap,
  matchesShortcut,
  shortcutConflicts,
  shortcutKeysFromEvent
} from './keymap';

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

describe('Element Source Inspector shortcut', () => {
  it('uses the verified default without a registry conflict', () => {
    expect(shortcutConflicts(Keymap.elementSourceInspector.keys)).toEqual([]);
  });

  it('matches the complete default modifier chord', () => {
    expect(matchesShortcut(
      keydown({ key: 'S', ctrlKey: true, altKey: true, shiftKey: true }),
      Keymap.elementSourceInspector.keys
    )).toBe(true);
    expect(matchesShortcut(
      keydown({ key: 'S', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }),
      Keymap.elementSourceInspector.keys
    )).toBe(true);
    expect(matchesShortcut(
      keydown({ key: 'S', ctrlKey: true, altKey: true, shiftKey: false }),
      Keymap.elementSourceInspector.keys
    )).toBe(false);
  });

  it('serializes a recorded chord in display order', () => {
    expect(shortcutKeysFromEvent(
      keydown({ key: 'S', ctrlKey: true, altKey: true, shiftKey: true })
    )).toEqual(['Ctrl', 'Alt', 'Shift', 'S']);
  });
});
