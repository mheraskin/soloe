import type { DiffRpcRequest, DiffRpcResult } from '@shared/types/diff-rpc.js';
import type { GitCommit } from '@shared/types/git.js';
import { ipc } from './ipc';
import { git } from '../stores/git.svelte';
import { rightRail } from '../stores/right-rail.svelte';
import { sessions } from '../stores/sessions.svelte';
import { workingDiff } from '../stores/working-diff.svelte';

let initialized = false;

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
    result = await dispatch(req);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  window.soloe.diff.sendRpcResponse({ requestId: req.requestId, result });
}

async function dispatch(req: DiffRpcRequest): Promise<DiffRpcResult> {
  switch (req.op) {
    case 'open_for_commits': {
      const { cwd, base, head, commits, includeWorkingTree, focusPath } = req.args;
      // The worktree-scope-open-sessions rule: refuse to operate on a cwd that
      // isn't already an open session/worktree. Prevents the bridge from
      // synthesizing UI state for a directory the user hasn't surfaced.
      const known = sessions.sessions.some((s) => s.cwd === cwd);
      if (!known) return { ok: false, error: `cwd is not an open session: ${cwd}` };
      if (commits.length === 0) return { ok: false, error: 'no commits provided' };

      // Re-fetch the topo-ordered range so the chip rendering and file list
      // use git's ordering (matches what the picker does on Apply).
      const ctx = git.contextFor(cwd);
      let ordered: GitCommit[] = [];
      try {
        const between = await ipc.git.commitsBetween({ cwd, base, head, ...ctx });
        ordered = between.commits;
      } catch (err) {
        return { ok: false, error: `commitsBetween failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (ordered.length === 0) {
        return { ok: false, error: 'range resolved to zero commits' };
      }

      workingDiff.setReviewMode(cwd, {
        kind: 'range',
        base,
        head,
        commits: ordered,
        includeWorkingTree,
        chipFilter: null
      });
      rightRail.setActiveCwd(cwd);
      rightRail.openTab('diff');
      if (focusPath) workingDiff.setSelected(cwd, focusPath);

      return {
        ok: true,
        cwd,
        base,
        head,
        commitCount: ordered.length
      };
    }
    default: {
      const op: never = req.op;
      return { ok: false, error: `unknown op: ${String(op)}` };
    }
  }
}
