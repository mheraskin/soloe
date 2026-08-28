export const SHIFT_ENTER_SEQUENCE = '\x1b[13;2u';
export const CTRL_SLASH_SEQUENCE = '\x1f';

type KeyboardLike = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
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

export function ctrlSlashSequence(event: KeyboardLike): string | null {
  // Prefer the physical Slash key so Ghostty sees one unambiguous control byte,
  // but also match the produced character because many layouts place "/" on
  // another physical key (for example Shift+7). Emit Ctrl+_ (US, 0x1f), the
  // control character terminal applications expect from Ctrl+/.
  const isSlash = event.code === 'Slash' || event.key === '/';
  return event.ctrlKey && !event.metaKey && !event.altKey && isSlash
    ? CTRL_SLASH_SEQUENCE
    : null;
}

// Sequences emitted for Alt-modified word edit/navigation. Caller must have
// verified altKey is set with no ctrl/meta. These conventional VT sequences
// (\x1b\x7f for Alt+Backspace, \x1b[3;3~ for Alt+Delete) parse cleanly in
// agent TUIs (claude code via ink/keypress, codex via crossterm) but bash
// readline doesn't bind \e\x7f to backward-kill-word out of the box and tty
// canonical-mode werase ignores it too. So for plain shells we fall back to
// the readline mnemonics every line discipline understands: Ctrl+W
// (backward-kill-word / werase) and Meta+d (forward kill-word).
type AltEditSession = {
  launch?: { type?: string; provider?: string } | null;
  currentAgentRuntime?: { provider?: string } | null;
} | null;

function isAgentSession(session: AltEditSession): boolean {
  if (!session) return false;
  if (session.launch?.type === 'agent') return true;
  const provider = session.currentAgentRuntime?.provider;
  return provider === 'claude_code'
    || provider === 'codex'
    || provider === 'cursor'
    || provider === 'opencode'
    || provider === 'grok_build';
}

export function altWordEditSequence(
  event: KeyboardLike,
  session: AltEditSession = null
): string | null {
  const agent = isAgentSession(session);
  switch (event.key) {
    case 'Backspace':
      return agent ? '\x1b\x7f' : '\x17';
    case 'Delete':
      return agent ? '\x1b[3;3~' : '\x1bd';
    case 'ArrowLeft':
      return '\x1b[1;3D';
    case 'ArrowRight':
      return '\x1b[1;3C';
    default:
      return null;
  }
}
