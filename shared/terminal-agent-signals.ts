import type { AgentRuntimeProvider } from './types/sessions.js';

const SIGNAL_TAIL_LENGTH = 256;
const SIGNAL_CANDIDATE =
  /allow|permission|approval|approve mode|run this|proceed with|limit|credit|❯/i;

export interface TerminalAgentSignalScan {
  tail: string;
  text: string;
  candidateText: string | null;
}

export function scanTerminalAgentSignals(
  previousTail: string,
  data: string
): TerminalAgentSignalScan {
  const text = data.includes('\x1b') ? stripAnsi(data) : data;
  if (!text) return { tail: previousTail, text, candidateText: null };
  const signalText = `${previousTail}${text}`;
  return {
    tail: signalText.slice(-SIGNAL_TAIL_LENGTH),
    text,
    candidateText: SIGNAL_CANDIDATE.test(signalText) ? signalText : null
  };
}

export function isApprovalPromptOutput(
  text: string,
  provider: AgentRuntimeProvider
): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  if (normalized.includes('do you want to allow')
    || normalized.includes('needs your permission')
    || normalized.includes('waiting for approval')) {
    return true;
  }
  if (provider !== 'cursor') return false;
  return normalized.includes('run this command?')
    || normalized.includes('run this command outside the sandbox?')
    || normalized.includes('proceed with this edit?')
    || normalized.includes('run this mcp tool?')
    || normalized.includes('allow this web fetch?')
    || normalized.includes('allow this web search?')
    || normalized.includes('approve mode switch (y/n)');
}

export function isClaudeIdlePromptOutput(text: string): boolean {
  return /(?:^|[\r\n])\s*❯(?:\s|$)/u.test(text);
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
}
