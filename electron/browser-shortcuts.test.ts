import { describe, expect, it } from 'vitest';
import {
  isBrowserDevToolsToggleInput,
  isBrowserRestoreTabInput,
  type BrowserShortcutInput
} from './browser-shortcuts.js';

function input(overrides: Partial<BrowserShortcutInput> = {}): BrowserShortcutInput {
  return {
    type: 'keyDown',
    key: 'i',
    control: true,
    meta: false,
    shift: true,
    alt: false,
    ...overrides
  };
}

describe('isBrowserDevToolsToggleInput', () => {
  it('matches Control-Shift-I', () => {
    expect(isBrowserDevToolsToggleInput(input(), 'linux')).toBe(true);
    expect(isBrowserDevToolsToggleInput(input({ key: 'I' }), 'win32')).toBe(true);
  });

  it('matches Command-Shift-C on macOS', () => {
    expect(
      isBrowserDevToolsToggleInput(
        input({ key: 'c', control: false, meta: true }),
        'darwin'
      )
    ).toBe(true);
  });

  it('matches Command-Option-I on macOS', () => {
    expect(
      isBrowserDevToolsToggleInput(
        input({ control: false, meta: true, shift: false, alt: true }),
        'darwin'
      )
    ).toBe(true);
  });

  it('rejects partial, modified, and platform-inappropriate shortcuts', () => {
    expect(isBrowserDevToolsToggleInput(input({ shift: false }), 'linux')).toBe(false);
    expect(isBrowserDevToolsToggleInput(input({ alt: true }), 'linux')).toBe(false);
    expect(
      isBrowserDevToolsToggleInput(
        input({ control: false, meta: true, shift: false, alt: true }),
        'linux'
      )
    ).toBe(false);
    expect(isBrowserDevToolsToggleInput(input({ type: 'keyUp' }), 'linux')).toBe(false);
    expect(
      isBrowserDevToolsToggleInput(
        input({ key: 'c', control: false, meta: true }),
        'linux'
      )
    ).toBe(false);
  });
});

describe('isBrowserRestoreTabInput', () => {
  it('matches Control-Shift-T on Windows and Linux', () => {
    expect(isBrowserRestoreTabInput(input({ key: 't' }), 'linux')).toBe(true);
    expect(isBrowserRestoreTabInput(input({ key: 'T' }), 'win32')).toBe(true);
  });

  it('matches Command-Shift-T on macOS', () => {
    expect(
      isBrowserRestoreTabInput(
        input({ key: 't', control: false, meta: true }),
        'darwin'
      )
    ).toBe(true);
  });

  it('rejects the wrong modifier for each platform and extra modifiers', () => {
    expect(isBrowserRestoreTabInput(input({ key: 't' }), 'darwin')).toBe(false);
    expect(
      isBrowserRestoreTabInput(
        input({ key: 't', control: false, meta: true }),
        'linux'
      )
    ).toBe(false);
    expect(isBrowserRestoreTabInput(input({ key: 't', alt: true }), 'linux')).toBe(false);
    expect(isBrowserRestoreTabInput(input({ key: 't', shift: false }), 'linux')).toBe(false);
  });
});
