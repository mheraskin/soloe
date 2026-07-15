import type { RunMode } from '@shared/types/sessions.js';
import { worktreeIdentityKey } from '@shared/worktree-identity.js';
import type { WorktreePollIntent } from '../stores/git.svelte';

export interface PollingSession {
  id: string;
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
}

/**
 * Converts Session presence into one polling intent per Worktree Identity.
 * Only the selected Worktree receives foreground cadence; a long-lived
 * background shell is presence, not foreground observation demand.
 */
export function sessionRefreshIntents(
  sessionList: readonly PollingSession[],
  selectedSessionId: string | null | undefined
): WorktreePollIntent[] {
  const byIdentity = new Map<string, WorktreePollIntent>();
  for (const session of sessionList) {
    const cwd = session.cwd.trim();
    if (!cwd) continue;
    const context = {
      runMode: session.runMode,
      ...(session.wslDistro ? { wslDistro: session.wslDistro } : {})
    };
    const key = worktreeIdentityKey(cwd, context);
    const selected = session.id === selectedSessionId;
    const previous = byIdentity.get(key);
    byIdentity.set(key, {
      cwd,
      cadence: previous?.cadence === 'foreground' || selected ? 'foreground' : 'background',
      runMode: previous?.runMode ?? session.runMode,
      ...(previous?.wslDistro
        ? { wslDistro: previous.wslDistro }
        : session.wslDistro
          ? { wslDistro: session.wslDistro }
          : {})
    });
  }
  return [...byIdentity.values()];
}
