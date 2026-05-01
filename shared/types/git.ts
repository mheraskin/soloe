export interface GitStatus {
  cwd: string;
  repoPath: string | null;
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface GitStatusRequest {
  cwd: string;
  force?: boolean;
}

export interface GitRepoRequest {
  repoPath: string;
}

export interface GitRecentCommitsRequest extends GitRepoRequest {
  limit?: number;
}

export interface GitCheckoutRequest extends GitRepoRequest {
  ref: string;
  force?: boolean;
}

export interface GitAheadBehind {
  repoPath: string;
  isRepo: boolean;
  ahead: number;
  behind: number;
}

export interface GitDirty {
  repoPath: string;
  isRepo: boolean;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface GitShortstat {
  repoPath: string;
  isRepo: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  lastCommit: string | null;
  lastCommitAt: string | null;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export interface GitChangeEvent {
  repoPath: string;
}
