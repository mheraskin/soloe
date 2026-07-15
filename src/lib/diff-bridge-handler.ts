import type { DiffRpcRequest, DiffRpcResult } from '@shared/types/diff-rpc.js';
import {
  sameWorktreeIdentity
} from '@shared/worktree-identity.js';
import { rightRail } from '../stores/right-rail.svelte';
import { sessions } from '../stores/sessions.svelte';
import { workingDiff } from '../stores/working-diff.svelte';

let initialized = false;

export interface DiffRequestDeps {
  sessions: Pick<typeof sessions, 'sessions' | 'select'>;
  workingDiff: Pick<typeof workingDiff, 'setReviewMode' | 'setSelected'>;
  rightRail: Pick<typeof rightRail, 'setActiveCwd' | 'openTab'>;
}

const defaultDeps: DiffRequestDeps = { sessions, workingDiff, rightRail };

export function initDiffBridge(): void {
  if (initialized) return;
  initialized = true;
  window.soloe.diff.onRpcRequest((req) => {
    void handleRequest(req);
  });
}

async function handleRequest(req: DiffRpcRequest): Promise<void> {
  let result: DiffRpcResult;
  try {
    result = await dispatchDiffRequest(req);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  window.soloe.diff.sendRpcResponse({ requestId: req.requestId, result });
}

export async function dispatchDiffRequest(
  req: DiffRpcRequest,
  deps: DiffRequestDeps = defaultDeps
): Promise<DiffRpcResult> {
  switch (req.op) {
    case 'open_for_commits': {
      const { target, base, head, commits, includeWorkingTree, focusPath } = req.args;
      const { scope, sessionId } = target;
      const { cwd } = scope;
      // The worktree-scope-open-sessions rule: refuse to operate on a cwd that
      // isn't already an open session/worktree. Prevents the bridge from
      // synthesizing UI state for a directory the user hasn't surfaced.
      const session = deps.sessions.sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return { ok: false, error: `session is not open: ${sessionId}` };
      if (!sameWorktreeIdentity(session.cwd, session, scope.cwd, scope)) {
        return { ok: false, error: `session Worktree Scope mismatch: ${sessionId}` };
      }
      if (commits.length === 0) return { ok: false, error: 'no commits provided' };

      deps.workingDiff.setReviewMode(scope, {
        kind: 'range',
        base,
        head,
        commits,
        includeWorkingTree,
        chipFilter: null
      });
      deps.sessions.select(sessionId);
      deps.rightRail.setActiveCwd(cwd);
      deps.rightRail.openTab('diff');
      // The bridge opens a commit review, so a duplicated WT/range path must
      // focus the committed row rather than whichever path happens to appear
      // first in the merged list.
      if (focusPath) deps.workingDiff.setSelected(scope, focusPath, 'committed');

      return {
        ok: true,
        sessionId,
        cwd,
        base,
        head,
        commitCount: commits.length
      };
    }
    default: {
      const op: never = req.op;
      return { ok: false, error: `unknown op: ${String(op)}` };
    }
  }
}
