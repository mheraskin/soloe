import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import type {
  BlameLine,
  DiscardFileEntry,
  FileBlameResult,
  FileDiff,
  GitAheadBehind,
  GitBranch,
  GitChangeEvent,
  GitCommit,
  GitCommitResult,
  GitDirty,
  GitHistoryCommit,
  GitHistoryRef,
  GitRemoteOpResult,
  GitShortstat,
  GitStatus,
  GitWorktree,
  RangeChange,
  ReviewDiffTarget,
  WorkingChange,
  WorkingChangeKind,
  WorkingChangesResult,
  WorkingTreeSnapshot
} from '@shared/types/git.js';
import type { RunMode } from '@shared/types/sessions.js';
import { materializeReviewDiffs, parseUnifiedDiff } from './ReviewDiffMaterializer.js';
import { UntrackedFileCounter } from './UntrackedFileCounter.js';
import { worktreeHostPath } from '../runtime/wsl-paths.js';
import { nativeRunMode } from '@shared/platform.js';
import {
  runGitCommand,
  type GitCommandOptions
} from './GitCommandRunner.js';
import { worktreeIdentityKey } from '@shared/worktree-identity.js';

export interface GitServiceOptions {
  gitBinary?: string;
  getGitBinary?: () => Promise<string | undefined> | string | undefined;
  wslBinary?: string;
  runGit?: (
    cwd: string,
    args: string[],
    options?: GitExecutionOptions
  ) => Promise<GitResult>;
  runWslGit?: (
    distro: string,
    cwd: string,
    args: string[],
    options?: GitExecutionOptions
  ) => Promise<GitResult>;
  watchImpl?: typeof watch;
  maxRepoCaches?: number;
  maxRepoResolutions?: number;
}

interface RepoInfo {
  repoPath: string;
  gitDir: string;
  runMode: 'native' | 'wsl';
  wslDistro?: string;
}

interface GitRepoContext {
  runMode?: RunMode;
  wslDistro?: string;
}

interface RepoCache {
  info: RepoInfo;
  worktrees: GitWorktree[] | null;
  branches: GitBranch[] | null;
  commitsByLimit: Map<number, GitCommit[]>;
  refHistoryByLimit: Map<number, GitHistoryCommit[]>;
  workingTreeSnapshot: WorkingTreeSnapshot | null;
  epoch: number;
  watchers: FSWatcher[];
  debounce: NodeJS.Timeout | null;
  observationLeaseCount: number;
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type GitExecutionOptions = Pick<GitCommandOptions, 'stdoutLimitBytes'>;

interface RepoResolutionEntry {
  info: RepoInfo | null;
  expiresAt: number;
}

const EMPTY_COUNTS = {
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0
};

// Soft ceiling on `git log <base>..<head>` to protect the renderer from a
// 10k-commit accidental range. The picker warns when truncation hits.
const COMMITS_BETWEEN_CAP = 500;
// Repository identity is stable across ordinary edits, staging, commits, and
// branch changes. Re-discovering it on every 5-second WSL poll costs two
// `wsl.exe` launches before useful work begins, so retain it for one coarse
// inventory window. A known identity is stable enough to span several
// observations; negative results use a short TTL to notice newly-created
// repositories quickly.
const REPO_RESOLUTION_TTL_MS = 10 * 60_000;
const MISSING_REPO_RESOLUTION_TTL_MS = 5_000;
const DEFAULT_MAX_REPO_CACHES = 64;
const DEFAULT_MAX_REPO_RESOLUTIONS = 256;
const REVIEW_DIFF_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export class GitService {
  private readonly caches = new Map<string, RepoCache>();
  private readonly listeners = new Set<(event: GitChangeEvent) => void>();
  private readonly repoResolutions = new Map<string, RepoResolutionEntry>();
  private readonly repoResolutionRequests = new Map<string, Promise<RepoInfo | null>>();
  private readonly workingTreeSnapshotRequests = new Map<string, Promise<WorkingTreeSnapshot>>();
  private readonly untrackedFileCounter = new UntrackedFileCounter();
  private workingTreeGeneration = 0;

  constructor(private readonly options: GitServiceOptions = {}) {}

  /**
   * Acquire native filesystem observation for one Session-owned Worktree.
   * Passive reads intentionally do not watch repositories; the returned
   * idempotent release function owns the observation lifetime.
   */
  async acquireObservation(
    cwd: string,
    context: GitRepoContext = {}
  ): Promise<() => void> {
    const info = await this.resolveRepo(cwd, context);
    if (!info || info.runMode === 'wsl') return () => {};
    const cache = this.ensureCache(info);
    cache.observationLeaseCount += 1;
    if (cache.observationLeaseCount === 1) this.attachWatchers(cache);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      cache.observationLeaseCount = Math.max(0, cache.observationLeaseCount - 1);
      if (cache.observationLeaseCount > 0) return;
      this.closeWatchers(cache);
      cache.workingTreeSnapshot = null;
      this.clearUntrackedMeasurements(cache.info);
      this.trimRepoCaches();
    };
  }

  async getWorkingTreeSnapshot(
    cwd: string,
    force = false,
    context: GitRepoContext = {}
  ): Promise<WorkingTreeSnapshot> {
    const info = await this.resolveRepo(cwd, context);
    if (!info) {
      return {
        generation: ++this.workingTreeGeneration,
        status: emptyStatus(cwd),
        shortstat: emptyShortstat(cwd, false),
        workingChanges: { repoPath: null, isRepo: false, changes: [] }
      };
    }
    const cache = this.ensureCache(info);
    if (!force && cache.workingTreeSnapshot) return clone(cache.workingTreeSnapshot);
    const requestKey = repoInfoKey(info);
    const inflight = this.workingTreeSnapshotRequests.get(requestKey);
    if (inflight) return clone(await inflight);
    const epoch = cache.epoch;
    const request = this.materializeWorkingTreeSnapshot(cwd, info)
      .then((snapshot) => {
        if (cache.epoch === epoch) {
          cache.workingTreeSnapshot = snapshot;
        }
        return snapshot;
      })
      .finally(() => {
        if (this.workingTreeSnapshotRequests.get(requestKey) === request) {
          this.workingTreeSnapshotRequests.delete(requestKey);
        }
      });
    this.workingTreeSnapshotRequests.set(requestKey, request);
    return clone(await request);
  }

  private async materializeWorkingTreeSnapshot(
    cwd: string,
    info: RepoInfo
  ): Promise<WorkingTreeSnapshot> {
    let [statusOutput, trackedOutput] = await Promise.all([
      this.runInRepo(info, [
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all',
        '-z'
      ]),
      this.runInRepo(info, [
        'diff',
        '--no-color',
        '--numstat',
        '-z',
        '--diff-filter=AMDRCT',
        'HEAD'
      ])
    ]);
    let trackedEntries = trackedOutput.code === 0 ? parseNumstatZ(trackedOutput.stdout) : [];
    if (trackedOutput.code !== 0) {
      const fallback = await this.runInRepo(info, [
        'diff',
        '--no-color',
        '--numstat',
        '-z',
        '--cached',
        '--diff-filter=AMDRCT'
      ]);
      if (fallback.code === 0) trackedEntries = parseNumstatZ(fallback.stdout);
    }

    const parsedStatus = statusOutput.code === 0
      ? parsePorcelainV2Z(cwd, info.repoPath, statusOutput.stdout)
      : {
          status: emptyStatus(cwd),
          flagsByPath: new Map<string, WorkingPathFlags>(),
          untrackedPaths: []
        };
    const renameSources = new Set(
      trackedEntries.map((entry) => entry.fromPath).filter((value): value is string => !!value)
    );
    const untrackedFiles = parsedStatus.untrackedPaths.filter((file) => !renameSources.has(file));
    const measured = await this.measureUntrackedFiles(info, untrackedFiles);

    const changes: WorkingChange[] = trackedEntries.map((entry) => {
      const flags = parsedStatus.flagsByPath.get(entry.path);
      return {
        path: entry.path,
        fromPath: entry.fromPath,
        kind: flags?.kind ?? entry.kind,
        staged: flags?.staged ?? false,
        insertions: entry.insertions,
        deletions: entry.deletions,
        binary: entry.binary
      };
    });
    let untrackedInsertions = 0;
    for (const file of untrackedFiles) {
      const measurement = measured.get(file) ?? await this.untrackedInsertions(info, file);
      untrackedInsertions += measurement.lines;
      changes.push({
        path: file,
        fromPath: null,
        kind: 'untracked',
        staged: false,
        insertions: measurement.lines,
        deletions: 0,
        binary: measurement.binary
      });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));

    const status = parsedStatus.status;
    if (statusOutput.code === 0) {
      status.untracked = untrackedFiles.length;
      status.dirty = status.staged > 0 || status.unstaged > 0 || status.untracked > 0;
    }
    const shortstat: GitShortstat = {
      repoPath: info.repoPath,
      isRepo: true,
      filesChanged: trackedEntries.length + untrackedFiles.length,
      insertions:
        trackedEntries.reduce((sum, entry) => sum + entry.insertions, 0) + untrackedInsertions,
      deletions: trackedEntries.reduce((sum, entry) => sum + entry.deletions, 0)
    };
    return {
      generation: ++this.workingTreeGeneration,
      status,
      shortstat,
      workingChanges: { repoPath: info.repoPath, isRepo: true, changes }
    };
  }

  async getStatus(cwd: string, force = false, context: GitRepoContext = {}): Promise<GitStatus> {
    return (await this.getWorkingTreeSnapshot(cwd, force, context)).status;
  }

  async getBranch(repoPath: string): Promise<string | null> {
    const status = await this.getStatus(repoPath);
    return status.detached ? null : status.branch;
  }

  async getShortstat(
    repoPath: string,
    force = false,
    context: GitRepoContext = {}
  ): Promise<GitShortstat> {
    return (await this.getWorkingTreeSnapshot(repoPath, force, context)).shortstat;
  }

  async getAheadBehind(
    repoPath: string,
    force = false,
    context: GitRepoContext = {}
  ): Promise<GitAheadBehind> {
    const status = await this.getStatus(repoPath, force, context);
    return {
      repoPath: status.repoPath ?? repoPath,
      isRepo: status.isRepo,
      ahead: status.ahead,
      behind: status.behind
    };
  }

  async getDirty(
    repoPath: string,
    force = false,
    context: GitRepoContext = {}
  ): Promise<GitDirty> {
    const status = await this.getStatus(repoPath, force, context);
    return {
      repoPath: status.repoPath ?? repoPath,
      isRepo: status.isRepo,
      dirty: status.dirty,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked
    };
  }

  async listWorktrees(
    repoPath: string,
    force = false,
    context: GitRepoContext = {}
  ): Promise<GitWorktree[]> {
    const info = await this.resolveRepo(repoPath, context);
    if (!info) return [];
    const cache = this.ensureCache(info);
    if (!force && cache.worktrees) return clone(cache.worktrees);
    const output = await this.runInRepo(info, ['worktree', 'list', '--porcelain']);
    cache.worktrees = output.code === 0
      ? parseWorktrees(output.stdout, info.runMode === 'native')
      : [];
    return clone(cache.worktrees);
  }

  async listLocalBranches(
    repoPath: string,
    force = false,
    context: GitRepoContext = {}
  ): Promise<GitBranch[]> {
    const info = await this.resolveRepo(repoPath, context);
    if (!info) return [];
    const cache = this.ensureCache(info);
    if (!force && cache.branches && cache.branches.length > 0) return clone(cache.branches);
    const output = await this.runInRepo(info, [
      'branch',
      '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(committerdate:iso8601)%00%(subject)'
    ]);
    cache.branches = output.code === 0 ? parseBranches(output.stdout) : [];
    return clone(cache.branches);
  }

  async listRecentCommits(
    repoPath: string,
    limit?: number,
    force = false,
    context: GitRepoContext = {}
  ): Promise<GitCommit[]> {
    const safeLimit =
      limit === undefined ? null : Math.max(1, Math.trunc(limit));
    const info = await this.resolveRepo(repoPath, context);
    if (!info) return [];
    const cache = this.ensureCache(info);
    const cacheKey = safeLimit ?? 0;
    const cached = cache.commitsByLimit.get(cacheKey);
    if (!force && cached) return clone(cached);
    const args = ['log', '--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s'];
    if (safeLimit !== null) args.splice(1, 0, `-${safeLimit}`);
    const output = await this.runInRepo(info, args);
    const commits = output.code === 0 ? parseCommits(output.stdout) : [];
    cache.commitsByLimit.set(cacheKey, commits);
    return clone(commits);
  }

  async listRefHistory(
    repoPath: string,
    limit = 100,
    force = false,
    context: GitRepoContext = {}
  ): Promise<GitHistoryCommit[]> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    const info = await this.resolveRepo(repoPath, context);
    if (!info) return [];
    const cache = this.ensureCache(info);
    const cached = cache.refHistoryByLimit.get(safeLimit);
    if (!force && cached) return clone(cached);
    const output = await this.runInRepo(info, [
      'log',
      '--all',
      '--topo-order',
      `-${safeLimit}`,
      '--decorate=full',
      '--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s%x00%P%x00%D'
    ]);
    const history = output.code === 0 ? parseRefHistory(output.stdout) : [];
    cache.refHistoryByLimit.set(safeLimit, history);
    return clone(history);
  }

  async checkout(
    repoPath: string,
    ref: string,
    force = false,
    context: GitRepoContext = {}
  ): Promise<GitStatus> {
    const target = ref.trim();
    if (!target) throw new Error('Checkout ref is required');
    const info = await this.resolveRepo(repoPath, context);
    if (!info) throw new Error(`Not a git repository: ${repoPath}`);
    if (!force) {
      const dirty = await this.getDirty(info.repoPath, true, context);
      if (dirty.dirty) {
        throw new Error('Repository has uncommitted changes');
      }
    }
    const args = force ? ['checkout', '-f', target] : ['checkout', target];
    const output = await this.runInRepo(info, args);
    if (output.code !== 0) {
      throw new Error(output.stderr.trim() || `Failed to check out ${target}`);
    }
    this.invalidate(info);
    return this.getStatus(info.repoPath, true, context);
  }

  async createWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
    context: GitRepoContext = {}
  ): Promise<GitWorktree> {
    const targetPath = worktreePath.trim();
    const targetBranch = branch.trim();
    const targetBase = baseRef.trim();
    if (!targetPath) throw new Error('Worktree folder is required');
    if (!targetBranch) throw new Error('New branch name is required');
    if (!targetBase) throw new Error('Base branch is required');

    const info = await this.resolveRepo(repoPath, context);
    if (!info) throw new Error(`Not a git repository: ${repoPath}`);

    const branchCheck = await this.runInRepo(info, [
      'check-ref-format',
      '--branch',
      targetBranch
    ]);
    if (branchCheck.code !== 0) {
      throw new Error(branchCheck.stderr.trim() || `Invalid branch name: ${targetBranch}`);
    }

    const baseCheck = await this.runInRepo(info, [
      'rev-parse',
      '--verify',
      `${targetBase}^{commit}`
    ]);
    if (baseCheck.code !== 0) {
      throw new Error(baseCheck.stderr.trim() || `Base branch not found: ${targetBase}`);
    }

    const added = await this.runInRepo(info, [
      'worktree',
      'add',
      '-b',
      targetBranch,
      targetPath,
      targetBase
    ]);
    if (added.code !== 0) {
      throw new Error(added.stderr.trim() || added.stdout.trim() || 'Failed to create worktree');
    }

    this.invalidate(info);
    const worktrees = await this.listWorktrees(info.repoPath, true, context);
    const created = worktrees.find((worktree) =>
      normalizeComparablePath(worktree.path) === normalizeComparablePath(targetPath)
    );
    if (!created) throw new Error('Worktree was created but could not be rediscovered');
    return created;
  }

  // List every file with pending working-tree changes (staged + unstaged +
  // untracked), with per-file +/- counts. Untracked files run through
  // `diff --no-index` so a brand-new file shows real insertion totals.
  async listWorkingChanges(
    cwd: string,
    context: GitRepoContext = {}
  ): Promise<WorkingChangesResult> {
    return (await this.getWorkingTreeSnapshot(cwd, true, context)).workingChanges;
  }

  async stageFiles(
    cwd: string,
    paths: string[],
    context: GitRepoContext = {}
  ): Promise<void> {
    const info = await this.resolveRepo(cwd, context);
    if (!info || paths.length === 0) return;
    await this.runInRepo(info, ['add', '--', ...paths]);
    this.invalidate(info);
  }

  async unstageFiles(
    cwd: string,
    paths: string[],
    context: GitRepoContext = {}
  ): Promise<void> {
    const info = await this.resolveRepo(cwd, context);
    if (!info || paths.length === 0) return;
    const result = await this.runInRepo(info, ['reset', 'HEAD', '--', ...paths]);
    if (result.code !== 0) {
      // Fresh repo with no HEAD — unstage via rm --cached instead.
      await this.runInRepo(info, ['rm', '--cached', '--', ...paths]);
    }
    this.invalidate(info);
  }

  // Mirror VSCode's "Discard Changes": for each file, choose the right
  // restore strategy by kind. Untracked files are removed via clean; newly
  // added (or copied) files are removed from index AND disk via rm; modified
  // and deleted files come back from HEAD via checkout. Renames need both
  // sides — the new path is removed and the original is restored from HEAD.
  async discardFiles(
    cwd: string,
    files: DiscardFileEntry[],
    context: GitRepoContext = {}
  ): Promise<void> {
    const info = await this.resolveRepo(cwd, context);
    if (!info || files.length === 0) return;

    const restore = new Set<string>();
    const remove = new Set<string>();
    const cleanUntracked = new Set<string>();

    for (const f of files) {
      if (!f.path) continue;
      if (f.kind === 'untracked') {
        cleanUntracked.add(f.path);
      } else if (f.kind === 'added' || f.kind === 'copied') {
        remove.add(f.path);
      } else if (f.kind === 'renamed') {
        remove.add(f.path);
        if (f.fromPath) restore.add(f.fromPath);
      } else {
        restore.add(f.path);
      }
    }

    if (restore.size > 0) {
      await this.runInRepo(info, ['checkout', 'HEAD', '--', ...restore]);
    }
    if (remove.size > 0) {
      await this.runInRepo(info, ['rm', '--force', '--', ...remove]);
    }
    if (cleanUntracked.size > 0) {
      await this.runInRepo(info, ['clean', '-f', '--', ...cleanUntracked]);
    }

    this.invalidate(info);
  }

  async commit(
    cwd: string,
    message: string,
    stageAll: boolean,
    context: GitRepoContext = {}
  ): Promise<GitCommitResult> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error('Commit message is required');
    const info = await this.resolveRepo(cwd, context);
    if (!info) throw new Error(`Not a git repository: ${cwd}`);
    const args = ['commit', '-m', trimmed];
    if (stageAll) args.splice(1, 0, '-a');
    const result = await this.runInRepo(info, args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'git commit failed');
    }
    const head = await this.runInRepo(info, ['rev-parse', 'HEAD']);
    const hash = head.stdout.trim();
    this.invalidate(info);
    return { hash, shortHash: hash.slice(0, 7) };
  }

  async push(
    cwd: string,
    remote: string | undefined,
    branch: string | undefined,
    setUpstream: boolean,
    context: GitRepoContext = {}
  ): Promise<GitRemoteOpResult> {
    return this.runRemoteOp(cwd, ['push', ...(setUpstream ? ['-u'] : [])], remote, branch, context);
  }

  async pull(
    cwd: string,
    remote: string | undefined,
    branch: string | undefined,
    context: GitRepoContext = {}
  ): Promise<GitRemoteOpResult> {
    return this.runRemoteOp(cwd, ['pull', '--ff-only'], remote, branch, context);
  }

  async fetch(
    cwd: string,
    remote: string | undefined,
    context: GitRepoContext = {}
  ): Promise<GitRemoteOpResult> {
    return this.runRemoteOp(cwd, ['fetch', '--prune'], remote, undefined, context);
  }

  private async runRemoteOp(
    cwd: string,
    baseArgs: string[],
    remote: string | undefined,
    branch: string | undefined,
    context: GitRepoContext
  ): Promise<GitRemoteOpResult> {
    const info = await this.resolveRepo(cwd, context);
    if (!info) throw new Error(`Not a git repository: ${cwd}`);
    const args = [...baseArgs];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    const result = await this.runInRepo(info, args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${baseArgs[0]} failed`);
    }
    this.invalidate(info);
    return { stdout: result.stdout, stderr: result.stderr };
  }

  // Fetch a 1-based line range from the diff's old-side tree. Working-tree
  // reviews read HEAD; committed reviews read their canonical base SHA.
  async getFileLines(
    cwd: string,
    filePath: string,
    startLine: number,
    endLine: number,
    options: {
      revision?: { kind: 'head' } | { kind: 'commit'; sha: string };
      context?: GitRepoContext;
    } = {}
  ): Promise<{ lines: string[]; totalLines: number }> {
    const info = await this.resolveRepo(cwd, options.context ?? {});
    if (!info) return { lines: [], totalLines: 0 };
    if (!filePath || endLine < 1 || startLine > endLine) {
      return { lines: [], totalLines: 0 };
    }
    const revision = options.revision ?? { kind: 'head' as const };
    const ref = revision.kind === 'head' ? 'HEAD' : revision.sha;
    if (revision.kind === 'commit' && !/^[0-9a-f]{40}$/i.test(revision.sha)) {
      throw new Error('Historical file-line revision must be a canonical commit SHA');
    }
    const output = await this.runInRepo(info, ['show', `${ref}:${filePath}`]);
    if (output.code !== 0) return { lines: [], totalLines: 0 };
    const all = output.stdout.split('\n');
    // git emits a trailing newline for normal files, which split turns into
    // a phantom empty entry; drop it so totalLines reflects the real count.
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    const totalLines = all.length;
    const start = Math.max(1, Math.trunc(startLine));
    const end = Math.min(totalLines, Math.trunc(endLine));
    if (start > end) return { lines: [], totalLines };
    return { lines: all.slice(start - 1, end), totalLines };
  }

  async getFileDiff(
    cwd: string,
    targetPath: string,
    options: {
      fromPath?: string | null;
      contextLines?: number;
      // The caller already has a status snapshot identifying this path as
      // untracked, so avoid a guaranteed-empty tracked diff process.
      untracked?: boolean;
      // When both `base` and `head` are set, diff against `<base>..<head>`
      // instead of the default working-tree-vs-HEAD diff. The untracked
      // fallback is suppressed since the path must exist in the range.
      base?: string;
      head?: string;
      context?: GitRepoContext;
    } = {}
  ): Promise<FileDiff> {
    const ctx = options.context ?? {};
    const info = await this.resolveRepo(cwd, ctx);
    if (!info) {
      return {
        path: targetPath,
        fromPath: options.fromPath ?? null,
        kind: 'modified',
        binary: false,
        hunks: [],
        empty: true,
        truncated: false
      };
    }

    const contextLines = Math.max(0, Math.trunc(options.contextLines ?? 3));
    const rangeMode = !!(options.base && options.head);
    const rangeArg = rangeMode ? `${options.base}..${options.head}` : 'HEAD';
    const args = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      `--unified=${contextLines}`,
      rangeArg,
      '--',
      ...(options.fromPath ? [options.fromPath] : []),
      targetPath
    ];

    const untrackedArgs = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      `--unified=${contextLines}`,
      '--no-index',
      '--',
      '/dev/null',
      targetPath
    ];
    const knownUntracked = !rangeMode && options.untracked === true;
    let output = await this.runInRepo(
      info,
      knownUntracked ? untrackedArgs : args,
      { stdoutLimitBytes: REVIEW_DIFF_OUTPUT_LIMIT_BYTES }
    );
    let mode: 'tracked' | 'untracked-fallback' =
      knownUntracked ? 'untracked-fallback' : 'tracked';

    if (reviewOutputExceeded(output)) {
      return truncatedFileDiff(targetPath, options.fromPath ?? null);
    }

    if (!rangeMode && !knownUntracked && (output.code !== 0 || !output.stdout.trim())) {
      // No commit yet, or path is untracked: try the new-file fallback.
      const untracked = await this.runInRepo(info, untrackedArgs, {
        stdoutLimitBytes: REVIEW_DIFF_OUTPUT_LIMIT_BYTES
      });
      if (reviewOutputExceeded(untracked)) {
        return truncatedFileDiff(targetPath, options.fromPath ?? null, 'untracked');
      }
      // `--no-index` returns code 1 when the files differ — which is the
      // normal case here. Treat any stdout as success.
      if (untracked.stdout.trim().length > 0) {
        output = untracked;
        mode = 'untracked-fallback';
      }
    }

    const parsed = parseUnifiedDiff(output.stdout);
    // The --no-index branch always synthesizes a "new file" header, which
    // would parse as kind='added'. Force 'untracked' so the UI can label the
    // file as never-staged versus a true staged-add.
    const kind =
      mode === 'untracked-fallback' ? 'untracked' : parsed?.kind ?? 'modified';
    return {
      path: targetPath,
      fromPath: options.fromPath ?? parsed?.fromPath ?? null,
      kind,
      binary: parsed?.binary ?? false,
      hunks: parsed?.hunks ?? [],
      empty: !parsed || parsed.hunks.length === 0,
      truncated: parsed?.truncated ?? false
    };
  }

  /**
   * Materialize the tracked portion of a review with one repository-level
   * Git command. Files Git omits (normally untracked files) are absent so the
   * renderer can fetch only the file the user actually opens via getFileDiff.
   */
  async getReviewDiffs(
    cwd: string,
    files: readonly ReviewDiffTarget[],
    options: {
      contextLines?: number;
      base?: string;
      head?: string;
      context?: GitRepoContext;
    } = {}
  ): Promise<FileDiff[]> {
    if (files.length === 0) return [];
    const info = await this.resolveRepo(cwd, options.context ?? {});
    if (!info) return [];

    const contextLines = Math.max(0, Math.trunc(options.contextLines ?? 3));
    const rangeMode = !!(options.base && options.head);
    const rangeArg = rangeMode ? `${options.base}..${options.head}` : 'HEAD';
    const loadBatch = async (batch: readonly ReviewDiffTarget[]): Promise<FileDiff[]> => {
      const paths = Array.from(
        new Set(
          batch.flatMap((file) => [file.fromPath, file.path]).filter((p): p is string => !!p)
        )
      );
      const output = await this.runInRepo(
        info,
        [
          '-c',
          'core.quotePath=false',
          'diff',
          '--no-color',
          '--no-ext-diff',
          '-M',
          '-C',
          `--unified=${contextLines}`,
          rangeArg,
          '--',
          ...paths
        ],
        { stdoutLimitBytes: REVIEW_DIFF_OUTPUT_LIMIT_BYTES }
      );
      if (reviewOutputExceeded(output)) {
        if (batch.length === 1) {
          const file = batch[0]!;
          return [truncatedFileDiff(file.path, file.fromPath ?? null)];
        }
        const middle = Math.ceil(batch.length / 2);
        const left = await loadBatch(batch.slice(0, middle));
        const right = await loadBatch(batch.slice(middle));
        return [...left, ...right];
      }
      if (output.code !== 0 || !output.stdout.trim()) return [];
      return materializeReviewDiffs(output.stdout, batch);
    };
    return loadBatch(files);
  }

  private async untrackedInsertions(
    info: RepoInfo,
    file: string
  ): Promise<{ lines: number; binary: boolean }> {
    const result = await this.runInRepo(info, [
      'diff',
      '--no-color',
      '--numstat',
      '--no-index',
      '--',
      '/dev/null',
      file
    ]);
    // `--no-index` exits 1 when files differ; trust stdout regardless.
    const text = result.stdout.trim();
    if (!text) return { lines: 0, binary: false };
    const firstLine = text.split('\n')[0] ?? '';
    const [insRaw, , ...rest] = firstLine.split('\t');
    const trailer = rest.join('\t');
    if (insRaw === '-' || trailer === '-') return { lines: 0, binary: true };
    const lines = Number(insRaw);
    return { lines: Number.isFinite(lines) ? lines : 0, binary: false };
  }

  // Walk the commits reachable from `head` but not `base`, oldest first.
  // Topological order is mandatory — author-date sort breaks under rebase.
  async getCommitsBetween(
    cwd: string,
    base: string,
    head: string,
    context: GitRepoContext = {}
  ): Promise<{ commits: GitCommit[]; truncated: boolean }> {
    const info = await this.resolveRepo(cwd, context);
    if (!info) return { commits: [], truncated: false };
    const range = `${base}..${head}`;
    const result = await this.runInRepo(info, [
      'log',
      '--topo-order',
      '--reverse',
      `-${COMMITS_BETWEEN_CAP + 1}`,
      '--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s',
      range
    ]);
    if (result.code !== 0) return { commits: [], truncated: false };
    const parsed = parseCommits(result.stdout);
    const truncated = parsed.length > COMMITS_BETWEEN_CAP;
    return {
      commits: truncated ? parsed.slice(0, COMMITS_BETWEEN_CAP) : parsed,
      truncated
    };
  }

  // Enumerate every file touched in `base..head` with net per-file delta and
  // the per-commit attribution map (`commitsTouching`). Three git calls in
  // parallel: name-status drives the final kind + rename mapping, numstat
  // gives insertions/deletions, and a single `log --name-only` walk fills
  // commitsTouching. Rename detection (-M -C) is on everywhere so attribution
  // follows the destination path.
  async getRangeChanges(
    cwd: string,
    base: string,
    head: string,
    context: GitRepoContext = {}
  ): Promise<RangeChange[]> {
    const info = await this.resolveRepo(cwd, context);
    if (!info) return [];
    const range = `${base}..${head}`;
    const [nameStatus, numstat, perCommit] = await Promise.all([
      this.runInRepo(info, ['diff', '--name-status', '-z', '-M', '-C', range]),
      this.runInRepo(info, ['diff', '--numstat', '-z', '-M', '-C', range]),
      this.runInRepo(info, [
        'log',
        '--topo-order',
        '--reverse',
        '--name-only',
        '-z',
        '--pretty=format:%x01%H',
        range
      ])
    ]);
    if (nameStatus.code !== 0) return [];
    const statusEntries = parseNameStatusZ(nameStatus.stdout);
    const numstatEntries = numstat.code === 0 ? parseNumstatZ(numstat.stdout) : [];
    const touchingByPath = perCommit.code === 0
      ? parseLogNameOnlyZ(perCommit.stdout)
      : new Map<string, string[]>();

    // Numstat keys by destination path (rename-aware). Build lookup.
    const numByPath = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
    for (const n of numstatEntries) {
      numByPath.set(n.path, {
        insertions: n.insertions,
        deletions: n.deletions,
        binary: n.binary
      });
    }

    const out: RangeChange[] = [];
    for (const entry of statusEntries) {
      const num = numByPath.get(entry.path);
      // `commitsTouching` is keyed by destination path. For renames, also
      // merge anything that referenced the original path before the rename
      // landed — log --name-only emits the historical name for those revs.
      const merged: string[] = [];
      const seen = new Set<string>();
      const pushAll = (shas: string[] | undefined): void => {
        if (!shas) return;
        for (const sha of shas) {
          if (seen.has(sha)) continue;
          seen.add(sha);
          merged.push(sha);
        }
      };
      pushAll(touchingByPath.get(entry.path));
      if (entry.fromPath) pushAll(touchingByPath.get(entry.fromPath));
      out.push({
        path: entry.path,
        fromPath: entry.fromPath,
        kind: entry.kind,
        insertions: num?.insertions ?? 0,
        deletions: num?.deletions ?? 0,
        binary: num?.binary ?? false,
        commitsTouching: merged
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  // Blame a file at a specific revision. Whitespace, rename, and copy
  // detection are all on so mid-feature renames don't smear attribution onto
  // the rename commit. Full 40-char SHAs keep equality stable across packfile
  // growth — short SHA collisions are rare but real in monorepos.
  async getFileBlame(
    cwd: string,
    targetPath: string,
    head: string,
    context: GitRepoContext = {}
  ): Promise<FileBlameResult> {
    const info = await this.resolveRepo(cwd, context);
    if (!info) return { path: targetPath, head, lines: [] };
    const args = [
      'blame',
      '--line-porcelain',
      '-w',
      '-M',
      '-C',
      '--abbrev=40',
      head,
      '--',
      targetPath
    ];
    const result = await this.runInRepo(info, args);
    if (result.code !== 0) return { path: targetPath, head, lines: [] };
    return { path: targetPath, head, lines: parseLinePorcelain(result.stdout) };
  }

  // Map each input ref to a canonical 40-char SHA. Unresolvable refs come back
  // as null at the same index — callers decide whether to error or skip.
  async resolveCommitRefs(
    cwd: string,
    refs: string[],
    context: GitRepoContext = {}
  ): Promise<(string | null)[]> {
    const info = await this.resolveRepo(cwd, context);
    if (!info) return refs.map(() => null);
    const out: (string | null)[] = new Array(refs.length).fill(null);
    await Promise.all(
      refs.map(async (ref, i) => {
        const trimmed = ref.trim();
        if (!trimmed) return;
        const result = await this.runInRepo(info, ['rev-parse', '--verify', `${trimmed}^{commit}`]);
        if (result.code !== 0) return;
        const sha = result.stdout.trim();
        if (/^[0-9a-f]{40}$/.test(sha)) out[i] = sha;
      })
    );
    return out;
  }

  onChange(listener: (event: GitChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    for (const cache of this.caches.values()) {
      this.closeWatchers(cache);
    }
    this.caches.clear();
    this.repoResolutions.clear();
    this.repoResolutionRequests.clear();
    this.workingTreeSnapshotRequests.clear();
    this.untrackedFileCounter.clear();
    this.listeners.clear();
  }

  private async measureUntrackedFiles(
    info: RepoInfo,
    files: readonly string[]
  ): Promise<Map<string, { lines: number; binary: boolean }>> {
    try {
      const runMode: RunMode = info.runMode === 'wsl' ? 'wsl' : nativeRunMode();
      const hostRoot = worktreeHostPath(info.repoPath, runMode, info.wslDistro);
      return await this.untrackedFileCounter.measure(hostRoot, files);
    } catch {
      // If host-path translation or filesystem access is unavailable, callers
      // retain the authoritative per-file Git fallback.
      return new Map();
    }
  }

  private async resolveRepo(cwd: string, context: GitRepoContext = {}): Promise<RepoInfo | null> {
    const trimmed = cwd.trim();
    if (!trimmed) return null;
    const key = repoResolutionKey(trimmed, context);
    this.pruneExpiredRepoResolutions();
    const cached = this.repoResolutions.get(key);
    if (cached) {
      this.repoResolutions.delete(key);
      this.repoResolutions.set(key, cached);
      return cached.info;
    }
    const inflight = this.repoResolutionRequests.get(key);
    if (inflight) return inflight;

    const request = this.resolveRepoUncached(trimmed, context)
      .then((info) => {
        this.repoResolutions.set(key, {
          info,
          expiresAt: Date.now() + (info ? REPO_RESOLUTION_TTL_MS : MISSING_REPO_RESOLUTION_TTL_MS)
        });
        this.trimRepoResolutions();
        return info;
      })
      .finally(() => {
        if (this.repoResolutionRequests.get(key) === request) {
          this.repoResolutionRequests.delete(key);
        }
      });
    this.repoResolutionRequests.set(key, request);
    return request;
  }

  private async resolveRepoUncached(
    cwd: string,
    context: GitRepoContext
  ): Promise<RepoInfo | null> {
    const nativeInfo = await this.resolveNativeRepo(cwd);
    if (nativeInfo) return nativeInfo;
    return this.resolveWslRepo(cwd, context);
  }

  private async resolveNativeRepo(cwd: string): Promise<RepoInfo | null> {
    try {
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
    const toplevel = await this.run(cwd, ['rev-parse', '--show-toplevel']);
    if (toplevel.code !== 0) return null;
    const repoPath = normalizeNativeGitPath(toplevel.stdout.trim());
    if (!repoPath) return null;
    const gitDirResult = await this.run(repoPath, ['rev-parse', '--git-dir']);
    if (gitDirResult.code !== 0) return null;
    const rawGitDir = gitDirResult.stdout.trim();
    const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(repoPath, rawGitDir);
    return { repoPath, gitDir, runMode: 'native' };
  }

  private async resolveWslRepo(
    cwd: string,
    context: GitRepoContext
  ): Promise<RepoInfo | null> {
    if (context.runMode !== 'wsl') return null;
    const distro = context.wslDistro?.trim();
    if (!distro) return null;
    const toplevel = await this.runWsl(distro, cwd, ['rev-parse', '--show-toplevel']);
    if (toplevel.code !== 0) return null;
    const repoPath = toplevel.stdout.trim();
    if (!repoPath) return null;
    const gitDirResult = await this.runWsl(distro, repoPath, ['rev-parse', '--git-dir']);
    if (gitDirResult.code !== 0) return null;
    const rawGitDir = gitDirResult.stdout.trim();
    const gitDir = path.posix.isAbsolute(rawGitDir)
      ? rawGitDir
      : path.posix.resolve(repoPath, rawGitDir);
    return { repoPath, gitDir, runMode: 'wsl', wslDistro: distro };
  }

  private ensureCache(info: RepoInfo): RepoCache {
    const key = repoInfoKey(info);
    const existing = this.caches.get(key);
    if (existing) {
      this.caches.delete(key);
      this.caches.set(key, existing);
      return existing;
    }
    const cache: RepoCache = {
      info,
      worktrees: null,
      branches: null,
      commitsByLimit: new Map(),
      refHistoryByLimit: new Map(),
      workingTreeSnapshot: null,
      epoch: 0,
      watchers: [],
      debounce: null,
      observationLeaseCount: 0
    };
    this.caches.set(key, cache);
    this.trimRepoCaches(cache);
    return cache;
  }

  private attachWatchers(cache: RepoCache): void {
    if (cache.info.runMode === 'wsl') return;
    for (const target of [
      path.join(cache.info.gitDir, 'HEAD'),
      path.join(cache.info.gitDir, 'index'),
      cache.info.repoPath
    ]) {
      try {
        const watchImpl = this.options.watchImpl ?? watch;
        cache.watchers.push(
          watchImpl(target, { persistent: false }, () => this.invalidate(cache.info))
        );
      } catch {
        // Some repos have no index yet; the next status call will still work.
      }
    }
  }

  private closeWatchers(cache: RepoCache): void {
    if (cache.debounce) clearTimeout(cache.debounce);
    cache.debounce = null;
    for (const watcher of cache.watchers) {
      try {
        watcher.close();
      } catch {
        // best effort
      }
    }
    cache.watchers = [];
  }

  private invalidate(info: RepoInfo): void {
    const cache = this.caches.get(repoInfoKey(info));
    if (!cache) return;
    cache.worktrees = null;
    cache.branches = null;
    cache.commitsByLimit.clear();
    cache.refHistoryByLimit.clear();
    cache.workingTreeSnapshot = null;
    cache.epoch += 1;
    if (cache.debounce) clearTimeout(cache.debounce);
    cache.debounce = setTimeout(() => {
      cache.debounce = null;
      for (const listener of this.listeners) {
        try {
          listener({
            repoPath: info.repoPath,
            runMode: info.runMode === 'wsl' ? 'wsl' : nativeRunMode(),
            ...(info.wslDistro ? { wslDistro: info.wslDistro } : {})
          });
        } catch {
          // listener errors are isolated
        }
      }
    }, 150);
  }

  private trimRepoCaches(protectedCache?: RepoCache): void {
    const limit = positiveLimit(this.options.maxRepoCaches, DEFAULT_MAX_REPO_CACHES);
    if (this.caches.size <= limit) return;
    for (const [key, cache] of this.caches) {
      if (this.caches.size <= limit) break;
      if (cache === protectedCache) continue;
      if (cache.observationLeaseCount > 0) continue;
      this.closeWatchers(cache);
      this.clearUntrackedMeasurements(cache.info);
      this.caches.delete(key);
    }
  }

  private pruneExpiredRepoResolutions(): void {
    const now = Date.now();
    for (const [key, entry] of this.repoResolutions) {
      if (entry.expiresAt <= now) this.repoResolutions.delete(key);
    }
  }

  private trimRepoResolutions(): void {
    const limit = positiveLimit(
      this.options.maxRepoResolutions,
      DEFAULT_MAX_REPO_RESOLUTIONS
    );
    while (this.repoResolutions.size > limit) {
      const oldest = this.repoResolutions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.repoResolutions.delete(oldest);
    }
  }

  private clearUntrackedMeasurements(info: RepoInfo): void {
    try {
      const runMode: RunMode = info.runMode === 'wsl' ? 'wsl' : nativeRunMode();
      this.untrackedFileCounter.clearRoot(
        worktreeHostPath(info.repoPath, runMode, info.wslDistro)
      );
    } catch {
      // Host path translation is best-effort, just like measurement itself.
    }
  }

  private async gitBinary(): Promise<string> {
    if (this.options.getGitBinary) {
      const configured = await this.options.getGitBinary();
      if (configured) return configured;
    }
    return this.options.gitBinary ?? 'git';
  }

  private async run(
    cwd: string,
    args: string[],
    options: GitExecutionOptions = {}
  ): Promise<GitResult> {
    const binary = await this.gitBinary();
    return retryTransientGitFailure(() =>
      this.options.runGit
        ? this.options.runGit(cwd, args, options)
        : runGit(binary, cwd, args, options)
    );
  }

  private async runInRepo(
    info: RepoInfo,
    args: string[],
    options: GitExecutionOptions = {}
  ): Promise<GitResult> {
    if (info.runMode === 'wsl') {
      return this.runWsl(info.wslDistro!, info.repoPath, args, options);
    }
    return this.run(info.repoPath, args, options);
  }

  private async runWsl(
    distro: string,
    cwd: string,
    args: string[],
    options: GitExecutionOptions = {}
  ): Promise<GitResult> {
    return retryTransientGitFailure(() =>
      this.options.runWslGit
        ? this.options.runWslGit(distro, cwd, args, options)
        : runWslGit(this.options.wslBinary ?? 'wsl.exe', distro, cwd, args, options)
    );
  }
}

function repoResolutionKey(cwd: string, context: GitRepoContext): string {
  return worktreeIdentityKey(cwd, context);
}

function repoInfoKey(info: RepoInfo): string {
  return worktreeIdentityKey(info.repoPath, {
    runMode: info.runMode === 'wsl' ? 'wsl' : nativeRunMode(),
    ...(info.wslDistro ? { wslDistro: info.wslDistro } : {})
  });
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function emptyStatus(cwd: string): GitStatus {
  return {
    cwd,
    repoPath: null,
    isRepo: false,
    branch: null,
    head: null,
    detached: false,
    dirty: false,
    ...EMPTY_COUNTS
  };
}

function emptyShortstat(repoPath: string, isRepo: boolean): GitShortstat {
  return { repoPath, isRepo, filesChanged: 0, insertions: 0, deletions: 0 };
}

interface WorkingPathFlags {
  staged: boolean;
  unstaged: boolean;
  kind: WorkingChangeKind;
}

function parsePorcelainV2Z(
  cwd: string,
  repoPath: string,
  output: string
): {
  status: GitStatus;
  flagsByPath: Map<string, WorkingPathFlags>;
  untrackedPaths: string[];
} {
  const status: GitStatus = {
    cwd,
    repoPath,
    isRepo: true,
    branch: null,
    head: null,
    detached: false,
    dirty: false,
    ...EMPTY_COUNTS
  };
  const flagsByPath = new Map<string, WorkingPathFlags>();
  const untrackedPaths: string[] = [];
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? '';
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length).trim();
      if (oid && oid !== '(initial)') status.head = oid;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length).trim();
      if (head === '(detached)') status.detached = true;
      else status.branch = head;
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = record.slice('# branch.ab '.length).match(/\+(-?\d+)\s+-(-?\d+)/);
      if (match) {
        status.ahead = Number(match[1] ?? 0);
        status.behind = Number(match[2] ?? 0);
      }
      continue;
    }
    if (record.startsWith('? ')) {
      status.untracked += 1;
      untrackedPaths.push(record.slice(2));
      continue;
    }
    const recordKind = record[0];
    if (recordKind !== '1' && recordKind !== '2' && recordKind !== 'u') continue;
    const xy = record.slice(2, 4);
    const x = xy[0] ?? '.';
    const y = xy[1] ?? '.';
    const staged = x !== '.';
    const unstaged = y !== '.';
    if (staged) status.staged += 1;
    if (unstaged) status.unstaged += 1;
    const spacesBeforePath = recordKind === '1' ? 8 : recordKind === '2' ? 9 : 10;
    const filePath = fieldAfterSpaces(record, spacesBeforePath);
    if (filePath) {
      flagsByPath.set(filePath, {
        staged,
        unstaged,
        kind: changeKindFromStatus(x !== '.' ? x : y)
      });
    }
    // Rename/copy records carry the source path in the next NUL field.
    if (recordKind === '2') index += 1;
  }
  status.dirty = status.staged > 0 || status.unstaged > 0 || status.untracked > 0;
  return { status, flagsByPath, untrackedPaths };
}

function fieldAfterSpaces(record: string, count: number): string {
  let from = 0;
  for (let seen = 0; seen < count; seen++) {
    const space = record.indexOf(' ', from);
    if (space < 0) return '';
    from = space + 1;
  }
  return record.slice(from);
}

function normalizeComparablePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US');
}

function changeKindFromStatus(code: string): WorkingChangeKind {
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  return 'modified';
}

function parseWorktrees(output: string, native = false): GitWorktree[] {
  const out: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) out.push(current);
      current = {
        path: native
          ? normalizeNativeGitPath(line.slice('worktree '.length))
          : line.slice('worktree '.length),
        branch: null,
        head: null,
        detached: false,
        bare: false,
        isMain: false
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    if (line === 'detached') current.detached = true;
    if (line === 'bare') current.bare = true;
  }
  if (current) out.push(current);
  if (out.length > 0) out[0]!.isMain = true;
  return out;
}

function normalizeNativeGitPath(value: string): string {
  if (process.platform !== 'win32') return value;
  if (/^[a-zA-Z]:[\\/]/u.test(value) || /^[/\\]{2}[^/\\]/u.test(value)) {
    return path.win32.normalize(value.replace(/\//g, '\\'));
  }
  return value;
}

function parseBranches(output: string): GitBranch[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name = '', marker = '', upstream = '', lastCommitAt = '', lastCommit = ''] = line.split('\0');
      return {
        name,
        current: marker.trim() === '*',
        upstream: upstream || null,
        lastCommitAt: lastCommitAt || null,
        lastCommit: lastCommit || null
      };
    })
    .filter((branch) => branch.name.length > 0);
}

function parseCommits(output: string): GitCommit[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', shortHash = '', author = '', authoredAt = '', subject = ''] = line.split('\0');
      return { hash, shortHash, author, authoredAt, subject };
    })
    .filter((commit) => commit.hash.length > 0);
}

function parseRefHistory(output: string): GitHistoryCommit[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [
        hash = '',
        shortHash = '',
        author = '',
        authoredAt = '',
        subject = '',
        parents = '',
        decorations = ''
      ] = line.split('\0');
      return {
        hash,
        shortHash,
        author,
        authoredAt,
        subject,
        parents: parents.split(' ').filter(Boolean),
        refs: parseHistoryRefs(decorations)
      };
    })
    .filter((commit) => commit.hash.length > 0);
}

function parseHistoryRefs(decorations: string): GitHistoryRef[] {
  const refs = new Map<string, GitHistoryRef>();
  for (const rawPart of decorations.split(',')) {
    let part = rawPart.trim();
    if (!part) continue;
    let current = false;
    if (part.startsWith('HEAD -> ')) {
      current = true;
      part = part.slice('HEAD -> '.length);
    }
    if (part.startsWith('refs/heads/')) {
      const name = part.slice('refs/heads/'.length);
      refs.set(`branch:${name}`, { name, kind: 'branch', current });
    } else if (part.startsWith('refs/remotes/')) {
      const name = part.slice('refs/remotes/'.length);
      if (!name.endsWith('/HEAD')) {
        refs.set(`remote:${name}`, { name, kind: 'remote', current: false });
      }
    } else if (part.startsWith('tag: refs/tags/')) {
      const name = part.slice('tag: refs/tags/'.length);
      refs.set(`tag:${name}`, { name, kind: 'tag', current: false });
    } else if (part.startsWith('refs/tags/')) {
      const name = part.slice('refs/tags/'.length);
      refs.set(`tag:${name}`, { name, kind: 'tag', current: false });
    }
  }
  return Array.from(refs.values());
}

// `git blame --line-porcelain` emits one record per output line. Each record
// starts with a header `<sha> <orig-line> <final-line> [group-size]` then a
// series of `key value` metadata lines, and ends with a tab-prefixed content
// line. We only need sha + final line number + summary; the content line is
// in the diff already.
function parseLinePorcelain(output: string): BlameLine[] {
  const lines = output.split('\n');
  const out: BlameLine[] = [];
  let currentSha = '';
  let currentLineNo = 0;
  let currentSummary = '';
  for (const raw of lines) {
    if (raw.length === 0) continue;
    if (raw.startsWith('\t')) {
      if (currentSha && currentLineNo > 0) {
        out.push({ lineNo: currentLineNo, sha: currentSha, summary: currentSummary });
      }
      currentSummary = '';
      continue;
    }
    if (/^[0-9a-f]{40} /.test(raw)) {
      const parts = raw.split(' ');
      currentSha = parts[0] ?? '';
      currentLineNo = Number(parts[2] ?? parts[1] ?? 0);
      continue;
    }
    if (raw.startsWith('summary ')) {
      currentSummary = raw.slice('summary '.length);
    }
  }
  return out;
}

const TRANSIENT_GIT_FAILURE = /\b(?:EAGAIN|ENOMEM|EMFILE|ENFILE)\b|resource temporarily unavailable/i;

async function retryTransientGitFailure(run: () => Promise<GitResult>): Promise<GitResult> {
  const first = await run();
  if (first.code !== null || !TRANSIENT_GIT_FAILURE.test(first.stderr)) return first;
  return run();
}

function reviewOutputExceeded(result: GitResult): boolean {
  return result.code === null && /output exceeded \d+ bytes/i.test(result.stderr);
}

function truncatedFileDiff(
  path: string,
  fromPath: string | null,
  kind: WorkingChangeKind = 'modified'
): FileDiff {
  return {
    path,
    fromPath,
    kind,
    binary: false,
    hunks: [],
    empty: false,
    truncated: true
  };
}

function runGit(
  bin: string,
  cwd: string,
  args: string[],
  options: GitExecutionOptions = {}
): Promise<GitResult> {
  return runGitCommand(bin, args, { cwd, ...options });
}

function runWslGit(
  wslBinary: string,
  distro: string,
  cwd: string,
  args: string[],
  options: GitExecutionOptions = {}
): Promise<GitResult> {
  return runGitCommand(
    wslBinary,
    ['-d', distro, '--cd', cwd, '--', 'git', ...args],
    options
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

interface TrackedNumstat {
  path: string;
  fromPath: string | null;
  kind: WorkingChangeKind;
  insertions: number;
  deletions: number;
  binary: boolean;
}

function parseNumstatZ(output: string): TrackedNumstat[] {
  // `git diff --numstat -z` emits records terminated by NUL. Each record is
  // either `<ins>\t<del>\t<path>` (NUL) or, for renames/copies, that triple
  // followed by an extra NUL-terminated <fromPath> and <toPath>.
  const tokens = output.split('\0');
  const out: TrackedNumstat[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (!head) {
      i += 1;
      continue;
    }
    const parts = head.split('\t');
    if (parts.length < 3) {
      i += 1;
      continue;
    }
    const insRaw = parts[0] ?? '';
    const delRaw = parts[1] ?? '';
    const inlinePath = parts[2] ?? '';
    const binary = insRaw === '-' || delRaw === '-';
    const insertions = binary ? 0 : Number(insRaw) || 0;
    const deletions = binary ? 0 : Number(delRaw) || 0;

    if (inlinePath.length > 0) {
      out.push({
        path: inlinePath,
        fromPath: null,
        kind: classifyByDelta(insertions, deletions, binary),
        insertions,
        deletions,
        binary
      });
      i += 1;
      continue;
    }

    // Rename/copy form: read the next two NUL-separated names.
    const fromPath = tokens[i + 1] ?? '';
    const toPath = tokens[i + 2] ?? '';
    if (toPath) {
      out.push({
        path: toPath,
        fromPath: fromPath || null,
        kind: 'renamed',
        insertions,
        deletions,
        binary
      });
    }
    i += 3;
  }
  return out;
}

function classifyByDelta(
  insertions: number,
  deletions: number,
  binary: boolean
): WorkingChangeKind {
  if (binary) return 'modified';
  if (insertions > 0 && deletions === 0) return 'added';
  if (insertions === 0 && deletions > 0) return 'deleted';
  return 'modified';
}

interface NameStatusEntry {
  path: string;
  fromPath: string | null;
  kind: WorkingChangeKind;
}

// `git diff --name-status -z` emits records terminated by NUL. Each record
// starts with a single status letter (A/M/D/T) or a similarity-scored R<NN>/
// C<NN> for renames/copies. Rename and copy entries are followed by two extra
// NUL-separated tokens (from-path, to-path); plain entries inline the path
// after the status code joined by TAB.
function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split('\0');
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (!head) {
      i += 1;
      continue;
    }
    const code = head[0] ?? '';
    if (code === 'R' || code === 'C') {
      const fromPath = tokens[i + 1] ?? '';
      const toPath = tokens[i + 2] ?? '';
      if (toPath) {
        out.push({
          path: toPath,
          fromPath: fromPath || null,
          kind: code === 'R' ? 'renamed' : 'copied'
        });
      }
      i += 3;
      continue;
    }
    // Plain entries: "<code>\t<path>"
    const tabIdx = head.indexOf('\t');
    const inlinePath = tabIdx >= 0 ? head.slice(tabIdx + 1) : '';
    if (inlinePath) {
      let kind: WorkingChangeKind = 'modified';
      if (code === 'A') kind = 'added';
      else if (code === 'D') kind = 'deleted';
      else if (code === 'M' || code === 'T') kind = 'modified';
      out.push({ path: inlinePath, fromPath: null, kind });
    }
    i += 1;
  }
  return out;
}

// `git log --name-only -z --pretty=format:%x01%H` interleaves commit headers
// (a 0x01 byte followed by a 40-char SHA) with NUL-terminated file paths. The
// 0x01 sentinel sidesteps confusion with paths that contain newlines or other
// odd characters. Returns a map: path → ordered list of SHAs that touched it.
function parseLogNameOnlyZ(output: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!output) return out;
  // Split on the SOH sentinel; each chunk starts with the SHA, then NUL-
  // separated paths trailing it.
  const chunks = output.split('\x01');
  for (const chunk of chunks) {
    if (!chunk) continue;
    const tokens = chunk.split('\0');
    const sha = (tokens[0] ?? '').trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    for (let i = 1; i < tokens.length; i += 1) {
      const filePath = tokens[i];
      if (!filePath) continue;
      // git emits a trailing newline before the next SOH; strip leading \n.
      const cleaned = filePath.startsWith('\n') ? filePath.slice(1) : filePath;
      if (!cleaned) continue;
      let list = out.get(cleaned);
      if (!list) {
        list = [];
        out.set(cleaned, list);
      }
      list.push(sha);
    }
  }
  return out;
}
