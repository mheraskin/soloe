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
  launch?: { type: string; provider?: string };
  runMode: string;
  currentAgentRuntime?: { provider?: string };
}): boolean {
  const provider = session.currentAgentRuntime?.provider
    ?? (session.launch?.type === 'agent' ? session.launch.provider : undefined);
  return provider === 'claude_code' || session.runMode === 'wsl';
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

export function shouldPassCtrlSlashToTerminal(event: KeyboardLike): boolean {
  // Some keyboard layouts require Shift to produce '/', which otherwise
  // collides with Soloe's physical Ctrl+Shift+Slash split shortcut.
  return event.ctrlKey && !event.metaKey && !event.altKey && event.key === '/';
}

// Sequences emitted for Alt-modified word edit/navigation. Caller must have
// verified altKey is set with no ctrl/meta. xterm.js's defaults
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
  return provider === 'claude_code' || provider === 'codex';
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
