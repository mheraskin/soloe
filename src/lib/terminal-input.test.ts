import { describe, expect, it } from 'vitest';
import {
  AGENT_IMAGE_PASTE_SEQUENCE,
  altWordEditSequence,
  isClipboardPasteShortcut,
  SHIFT_ENTER_SEQUENCE,
  shouldPasteImageViaSavedPath,
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

  it('uses Ctrl+V passthrough for native agent image paste', () => {
    expect(AGENT_IMAGE_PASTE_SEQUENCE).toBe('\x16');
  });

  it('falls back to saved image paths where clipboard image paste is unreliable', () => {
    expect(shouldPasteImageViaSavedPath({ launch: { type: 'agent', provider: 'claude_code' }, runMode: 'windows' })).toBe(true);
    expect(shouldPasteImageViaSavedPath({
      launch: { type: 'terminal' },
      runMode: 'windows',
      currentAgentRuntime: { provider: 'claude_code' }
    })).toBe(true);
    expect(shouldPasteImageViaSavedPath({ launch: { type: 'agent', provider: 'codex' }, runMode: 'wsl' })).toBe(true);
    expect(shouldPasteImageViaSavedPath({ launch: { type: 'agent', provider: 'codex' }, runMode: 'windows' })).toBe(false);
  });

  it('emits readline mnemonics in plain shells for Alt-modified word keys', () => {
    expect(altWordEditSequence(key({ altKey: true, key: 'Backspace' }))).toBe('\x17');
    expect(altWordEditSequence(key({ altKey: true, key: 'Delete' }))).toBe('\x1bd');
    expect(altWordEditSequence(key({ altKey: true, key: 'ArrowLeft' }))).toBe('\x1b[1;3D');
    expect(altWordEditSequence(key({ altKey: true, key: 'ArrowRight' }))).toBe('\x1b[1;3C');
    expect(altWordEditSequence(key({ altKey: true, key: 'a' }))).toBeNull();
  });

  it('emits xterm-native sequences in agent TUI sessions for Alt+Backspace/Delete', () => {
    const claude = { launch: { type: 'agent', provider: 'claude_code' } };
    const codex = { launch: { type: 'agent', provider: 'codex' } };
    const promoted = { launch: { type: 'terminal' }, currentAgentRuntime: { provider: 'claude_code' } };
    expect(altWordEditSequence(key({ altKey: true, key: 'Backspace' }), claude)).toBe('\x1b\x7f');
    expect(altWordEditSequence(key({ altKey: true, key: 'Delete' }), claude)).toBe('\x1b[3;3~');
    expect(altWordEditSequence(key({ altKey: true, key: 'Backspace' }), codex)).toBe('\x1b\x7f');
    expect(altWordEditSequence(key({ altKey: true, key: 'Backspace' }), promoted)).toBe('\x1b\x7f');
    // Word nav stays the same in either context.
    expect(altWordEditSequence(key({ altKey: true, key: 'ArrowLeft' }), claude)).toBe('\x1b[1;3D');
  });
});
