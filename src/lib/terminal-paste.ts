import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
import { terminalControl } from '../stores/terminal-control.svelte';

// Claude Code and Codex both ship a bracketed-paste handler that buffers the
// entire `\x1b[200~ … \x1b[201~` body as one input event. If a trailing `\r`
// is concatenated to the same write, the agent's read() call returns paste
// body + end marker + Enter as a single chunk and the Enter is consumed as
// part of the paste body rather than as a submit keypress — the message
// lands in the prompt area without being sent. Splitting into two writes
// with a short yield lets the agent's event loop tick between exiting paste
// mode and processing Enter.
//
// Codex's TUI registers the trailing Enter after ~50ms, but Claude Code's
// Ink-based input needs noticeably longer to leave paste mode before it treats
// the `\r` as a submit instead of paste body — at 50ms the message lands unsent.
// Hence the per-provider yield (tune CLAUDE_SUBMIT_YIELD_MS if Claude still
// drops the submit).
const SUBMIT_YIELD_MS = 50;
const CLAUDE_SUBMIT_YIELD_MS = 150;

function submitYieldFor(provider: AgentRuntimeProvider | null | undefined): number {
  return provider === 'claude_code' ? CLAUDE_SUBMIT_YIELD_MS : SUBMIT_YIELD_MS;
}

export async function sendBracketedPaste(
  terminalId: string,
  text: string,
  submit: boolean,
  provider?: AgentRuntimeProvider | null
): Promise<void> {
  // Strip embedded ESC chars — an `\x1b[201~` inside the body would close
  // paste mode early and let the rest of the text execute as keystrokes.
  const sanitized = text.replace(/\x1b/g, '');
  await terminalControl.input(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
  if (!submit) return;
  await new Promise<void>((resolve) => setTimeout(resolve, submitYieldFor(provider)));
  await terminalControl.input(terminalId, '\r');
}
