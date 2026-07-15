import type { WorktreeScope } from '../worktree-identity.js';
import type { GitCommit } from './git.js';

export type DiffRpcOp = 'open_for_commits';

export interface DiffWorktreeTarget {
  sessionId: string;
  scope: WorktreeScope;
}

export interface OpenForCommitsRequest {
  target: DiffWorktreeTarget;
  base: string;
  head: string;
  commits: GitCommit[];
  includeWorkingTree: boolean;
  focusPath?: string;
}

export type DiffRpcRequest = {
  requestId: string;
  op: 'open_for_commits';
  args: OpenForCommitsRequest;
};

export type DiffRpcResult =
  | {
      ok: true;
      sessionId: string;
      cwd: string;
      base: string;
      head: string;
      commitCount: number;
    }
  | { ok: false; error: string };

export interface DiffRpcResponse {
  requestId: string;
  result: DiffRpcResult;
}
