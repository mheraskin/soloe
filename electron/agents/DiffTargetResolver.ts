import type { DiffWorktreeTarget } from '@shared/types/diff-rpc.js';
import type { Session } from '@shared/types/sessions.js';
import { sameWorktreeIdentity } from '@shared/worktree-identity.js';

export interface DiffSessionSource {
  get(id: string): Promise<Session | null>;
  list(): Promise<Session[]>;
}

export async function resolveDiffTarget(
  source: DiffSessionSource,
  input: { sessionId?: string; cwd?: string }
): Promise<DiffWorktreeTarget> {
  if (input.sessionId) {
    const session = await source.get(input.sessionId);
    if (!session) throw new Error(`unknown sessionId: ${input.sessionId}`);
    if (input.cwd && !samePath(input.cwd, session.cwd, session.runMode === 'windows')) {
      throw new Error(`sessionId ${input.sessionId} does not belong to cwd ${input.cwd}`);
    }
    return targetFromSession(session);
  }
  const cwd = input.cwd?.trim();
  if (!cwd) throw new Error('cwd or sessionId is required');
  const sessions = await source.list();
  const matches = sessions.filter((session) =>
    samePath(cwd, session.cwd, session.runMode === 'windows')
  );
  if (matches.length === 0) throw new Error(`cwd is not an open session: ${cwd}`);
  const first = matches[0]!;
  if (matches.some((session) =>
    !sameWorktreeIdentity(first.cwd, first, session.cwd, session)
  )) {
    throw new Error(`cwd is ambiguous across Worktree identities; provide sessionId: ${cwd}`);
  }
  return targetFromSession(first);
}

function targetFromSession(session: Session): DiffWorktreeTarget {
  return {
    sessionId: session.id,
    scope: {
      cwd: session.cwd,
      runMode: session.runMode,
      ...(session.wslDistro ? { wslDistro: session.wslDistro } : {})
    }
  };
}

function samePath(a: string, b: string, windows: boolean): boolean {
  const normalize = (value: string) => {
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return windows ? trimmed.toLocaleLowerCase('en-US') : trimmed;
  };
  return normalize(a) === normalize(b);
}
