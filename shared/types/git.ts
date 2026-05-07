import type { RunMode } from './sessions.js';

export interface GitStatus {
  cwd: string;
  repoPath: string | null;
  isRepo: boolean;
  branch: string | null;
  head: string | null;
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
  runMode?: RunMode;
  wslDistro?: string;
}

export interface GitRepoRequest {
  repoPath: string;
  force?: boolean;
  runMode?: RunMode;
  wslDistro?: string;
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
  isMain: boolean;
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

export type WorkingChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked';

export interface WorkingChange {
  // The path as currently seen on disk. For renames this is the new name.
  path: string;
  // Source path when renamed/copied; null otherwise.
  fromPath: string | null;
  kind: WorkingChangeKind;
  staged: boolean;
  insertions: number;
  deletions: number;
  // True for files git considers binary (we still surface them but with no hunks).
  binary: boolean;
}

export interface WorkingChangesRequest {
  cwd: string;
  force?: boolean;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface WorkingChangesResult {
  repoPath: string | null;
  isRepo: boolean;
  changes: WorkingChange[];
}

export type DiffLineKind = 'context' | 'add' | 'remove' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  // Old-file line number (1-based). Null for added or meta lines.
  oldLine: number | null;
  // New-file line number (1-based). Null for removed or meta lines.
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface StageFilesRequest {
  cwd: string;
  paths: string[];
  runMode?: RunMode;
  wslDistro?: string;
}

export interface FileDiffRequest {
  cwd: string;
  path: string;
  fromPath?: string | null;
  contextLines?: number;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface FileDiff {
  path: string;
  fromPath: string | null;
  kind: WorkingChangeKind;
  binary: boolean;
  hunks: DiffHunk[];
  // True when the file is empty after the change (e.g. deletion or empty add).
  empty: boolean;
}
