import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
import type { Session } from '@shared/types/sessions.js';
import { launchProvider } from '@shared/types/sessions.js';

export function continuationPrompt(
  origin: Session,
  observed: ObservedAgentSnapshot | null
): string {
  const provider = origin.currentAgentRuntime?.provider ?? launchProvider(origin) ?? 'terminal';
  const handoffReason = (() => {
    if (observed?.state === 'usage_limited') {
      return 'The previous agent appears to have hit a usage limit.';
    }
    if (observed?.state === 'failed') {
      return 'The previous Session stopped before completing the task.';
    }
    return 'The user requested this handoff from another Soloe Session.';
  })();
  return [
    'We are continuing from another Soloe Session.',
    handoffReason,
    '',
    'Continue the same task from that session. Preserve the user intent and current course of work.',
    'First inspect the raw session artifact if it is available, then continue from the latest useful state.',
    '',
    `Previous Soloe Session: ${origin.name || origin.id}`,
    `Previous provider: ${provider}`,
    `Working directory: ${origin.cwd}`,
    `Run mode: ${origin.runMode}${origin.wslDistro ? ` (${origin.wslDistro})` : ''}`,
    ...(origin.providerThreadId ? [`Provider session id: ${origin.providerThreadId}`] : []),
    ...(origin.transcriptPath ? [`Transcript/session JSON path: ${origin.transcriptPath}`] : []),
    ...(observed?.transcriptPath && observed.transcriptPath !== origin.transcriptPath
      ? [`Observed transcript path: ${observed.transcriptPath}`]
      : []),
    ...(observed?.usageLimit?.message ? [`Usage limit message: ${observed.usageLimit.message}`] : []),
    '',
    'If the raw artifact path is inaccessible, say what context is missing and ask for the smallest useful handoff instead of starting over.'
  ].join('\n');
}
