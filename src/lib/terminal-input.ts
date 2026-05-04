export const SHIFT_ENTER_SEQUENCE = '\x1b[13;2u';
export const AGENT_IMAGE_PASTE_SEQUENCE = '\x16';

type KeyboardLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

export function isClipboardPasteShortcut(event: KeyboardLike): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v';
}

export function shouldPasteImageViaSavedPath(session: {
  kind: string;
  runMode: string;
}): boolean {
  return session.kind === 'claude_code' || session.runMode === 'wsl';
}

export function shouldSendShiftEnterSequence(event: KeyboardLike): boolean {
  return (
    event.key === 'Enter'
    && event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
  );
}

// Sequences emitted for Alt-modified word edit/navigation. Caller must have
// verified altKey is set with no ctrl/meta. We bypass xterm's default CSI
// encodings for Backspace/Delete (\x1b\x7f and \x1b[3;3~) because TUIs like
// codex (ratatui/crossterm) and claude (ink/keypress) and shells with
// stty erase ^H don't reliably treat them as word-kill. Instead we emit the
// readline mnemonics every common parser handles: Ctrl+W for backward-kill-word
// and Meta+d for forward kill-word.
export function altWordEditSequence(event: KeyboardLike): string | null {
  switch (event.key) {
    case 'Backspace':
      return '\x17';
    case 'Delete':
      return '\x1bd';
    case 'ArrowLeft':
      return '\x1b[1;3D';
    case 'ArrowRight':
      return '\x1b[1;3C';
    default:
      return null;
  }
}
