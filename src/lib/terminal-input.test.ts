import { describe, expect, it } from 'vitest';
import {
  altWordEditSequence,
  isClipboardPasteShortcut,
  SHIFT_ENTER_SEQUENCE,
  shouldSendShiftEnterSequence
} from './terminal-input';

function key(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: '',
    metaKey: false,
    shiftKey: false,
    ...overrides
  } as KeyboardEvent;
}

describe('terminal input helpers', () => {
  it('recognises Ctrl+V and Cmd+V as paste shortcuts', () => {
    expect(isClipboardPasteShortcut(key({ ctrlKey: true, key: 'v' }))).toBe(true);
    expect(isClipboardPasteShortcut(key({ metaKey: true, key: 'V' }))).toBe(true);
    expect(isClipboardPasteShortcut(key({ ctrlKey: true, altKey: true, key: 'v' }))).toBe(false);
  });

  it('sends modified Enter for plain Shift+Enter only', () => {
    expect(shouldSendShiftEnterSequence(key({ key: 'Enter', shiftKey: true }))).toBe(true);
    expect(shouldSendShiftEnterSequence(key({ key: 'Enter' }))).toBe(false);
    expect(shouldSendShiftEnterSequence(key({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBe(false);
  });

  it('uses the CSI-u Shift+Enter sequence Codex-compatible terminals emit', () => {
    expect(SHIFT_ENTER_SEQUENCE).toBe('\x1b[13;2u');
  });

  it('emits readline word-edit and word-nav sequences for Alt-modified keys', () => {
    expect(altWordEditSequence(key({ altKey: true, key: 'Backspace' }))).toBe('\x1b\x7f');
    expect(altWordEditSequence(key({ altKey: true, key: 'Delete' }))).toBe('\x1b[3;3~');
    expect(altWordEditSequence(key({ altKey: true, key: 'ArrowLeft' }))).toBe('\x1b[1;3D');
    expect(altWordEditSequence(key({ altKey: true, key: 'ArrowRight' }))).toBe('\x1b[1;3C');
    expect(altWordEditSequence(key({ altKey: true, key: 'a' }))).toBeNull();
  });
});
