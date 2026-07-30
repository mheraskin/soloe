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

/** Session-owned demand for native repository filesystem observation. */
export interface GitObservationDemandRequest {
  cwd: string;
  active: boolean;
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

export interface GitRefHistoryRequest extends GitRepoRequest {
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

export type GitHistoryRefKind = 'branch' | 'remote' | 'tag';

export interface GitHistoryRef {
  name: string;
  kind: GitHistoryRefKind;
  current: boolean;
}

export interface GitHistoryCommit extends GitCommit {
  parents: string[];
  refs: GitHistoryRef[];
}

export interface GitChangeEvent {
  repoPath: string;
  runMode: RunMode;
  wslDistro?: string;
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
  // 'wt' for working-tree entries (the default), 'committed' for entries
  // that live in a base..head commit range. Absent ⇒ 'wt'.
  section?: 'wt' | 'committed';
  // Commits in the active range that modified this path. Populated only for
  // 'committed' section entries; empty otherwise.
  commitsTouching?: string[];
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

export interface WorkingTreeSnapshotRequest extends GitStatusRequest {}

/** One coherent working-tree observation shared by badges and review surfaces. */
export interface WorkingTreeSnapshot {
  generation: number;
  status: GitStatus;
  shortstat: GitShortstat;
  workingChanges: WorkingChangesResult;
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

export interface DiscardFileEntry {
  path: string;
  kind: WorkingChangeKind;
  fromPath?: string | null;
}

export interface DiscardFilesRequest {
  cwd: string;
  files: DiscardFileEntry[];
  runMode?: RunMode;
  wslDistro?: string;
}

export interface FileDiffRequest {
  cwd: string;
  path: string;
  fromPath?: string | null;
  contextLines?: number;
  // Skip the tracked probe and use `git diff --no-index` directly when the
  // caller already knows this working-tree path is untracked.
  untracked?: boolean;
  // When both are set, the diff is computed against `git diff <base>..<head>`
  // instead of the default working-tree-vs-HEAD diff. The untracked-file
  // fallback (--no-index) is suppressed in this mode.
  base?: string;
  head?: string;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface ReviewDiffTarget {
  path: string;
  fromPath?: string | null;
}

export interface ReviewDiffsRequest {
  cwd: string;
  files: ReviewDiffTarget[];
  contextLines?: number;
  base?: string;
  head?: string;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface BlameLine {
  // 1-based line number in the blamed revision (`head`).
  lineNo: number;
  // 40-char canonical SHA. Use full SHAs so equality vs. user-selected commits
  // is stable across packfile growth.
  sha: string;
  // Short summary line from the originating commit (first line of the message).
  summary: string;
}

export interface FileBlameRequest {
  cwd: string;
  path: string;
  // Revision to blame. Defaults to HEAD when omitted.
  head?: string;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface FileBlameResult {
  path: string;
  head: string;
  lines: BlameLine[];
}

export interface CommitsBetweenRequest {
  cwd: string;
  // Exclusive lower bound; results are commits reachable from `head` but not `base`.
  base: string;
  head: string;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface CommitsBetweenResult {
  base: string;
  head: string;
  // Topologically ordered, oldest first.
  commits: GitCommit[];
  // True when the range was truncated by the server-side cap.
  truncated: boolean;
}

export interface ResolveRefsRequest {
  cwd: string;
  refs: string[];
  runMode?: RunMode;
  wslDistro?: string;
}

export interface ResolveRefsResult {
  // Same order as input. null entries mark refs that failed to resolve.
  resolved: (string | null)[];
}

// One file's net change across a commit range. `commitsTouching` is the
// subset of the selected commits that modified this path; ordered topo
// (oldest first) to match `CommitsBetweenResult.commits`.
export interface RangeChange {
  path: string;
  fromPath: string | null;
  kind: WorkingChangeKind;
  insertions: number;
  deletions: number;
  binary: boolean;
  commitsTouching: string[];
}

export interface RangeChangesRequest {
  cwd: string;
  base: string;
  head: string;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface RangeChangesResult {
  base: string;
  head: string;
  changes: RangeChange[];
}

export interface FileLinesRequest {
  cwd: string;
  path: string;
  revision: { kind: 'head' } | { kind: 'commit'; sha: string };
  startLine: number;
  endLine: number;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface FileLinesResult {
  lines: string[];
  totalLines: number;
}

export interface GitCommitRequest {
  cwd: string;
  message: string;
  stageAll?: boolean;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface GitCommitResult {
  hash: string;
  shortHash: string;
}

export interface GitRemoteOpRequest {
  cwd: string;
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  runMode?: RunMode;
  wslDistro?: string;
}

export interface GitRemoteOpResult {
  stdout: string;
  stderr: string;
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
