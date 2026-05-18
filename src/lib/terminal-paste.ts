import { ipc } from './ipc';

// Claude Code and Codex both ship a bracketed-paste handler that buffers the
// entire `\x1b[200~ … \x1b[201~` body as one input event. If a trailing `\r`
// is concatenated to the same write, the agent's read() call returns paste
// body + end marker + Enter as a single chunk and the Enter is consumed as
// part of the paste body rather than as a submit keypress — the message
// lands in the prompt area without being sent. Splitting into two writes
// with a short yield lets the agent's event loop tick between exiting paste
// mode and processing Enter.
const SUBMIT_YIELD_MS = 50;

export async function sendBracketedPaste(
  terminalId: string,
  text: string,
  submit: boolean
): Promise<void> {
  // Strip embedded ESC chars — an `\x1b[201~` inside the body would close
  // paste mode early and let the rest of the text execute as keystrokes.
  const sanitized = text.replace(/\x1b/g, '');
  await ipc.terminal.input(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
  if (!submit) return;
  await new Promise<void>((resolve) => setTimeout(resolve, SUBMIT_YIELD_MS));
  await ipc.terminal.input(terminalId, '\r');
}
