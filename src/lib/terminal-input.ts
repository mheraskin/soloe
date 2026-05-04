export const SHIFT_ENTER_SEQUENCE = '\x1b[13;2u';

type KeyboardLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

export function isClipboardPasteShortcut(event: KeyboardLike): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v';
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

// Standard readline / xterm escape sequences for Alt-modified word edit and
// navigation. Caller must already have verified altKey is set with no ctrl/meta.
export function altWordEditSequence(event: KeyboardLike): string | null {
  switch (event.key) {
    case 'Backspace':
      return '\x1b\x7f';
    case 'Delete':
      return '\x1b[3;3~';
    case 'ArrowLeft':
      return '\x1b[1;3D';
    case 'ArrowRight':
      return '\x1b[1;3C';
    default:
      return null;
  }
}
