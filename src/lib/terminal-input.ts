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
