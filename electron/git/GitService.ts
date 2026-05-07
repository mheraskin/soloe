import { spawn } from 'node:child_process';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import type {
  DiffHunk,
  DiffLine,
  DiffLineKind,
  DiscardFileEntry,
  FileDiff,
  GitAheadBehind,
  GitBranch,
  GitCommit,
  GitDirty,
  GitShortstat,
  GitStatus,
  GitWorktree,
  WorkingChange,
  WorkingChangeKind,
  WorkingChangesResult
} from '@shared/types/git.js';
import type { RunMode } from '@shared/types/sessions.js';

export interface GitServiceOptions {
  gitBinary?: string;
  getGitBinary?: () => Promise<string | undefined> | string | undefined;
  wslBinary?: string;
  runWslGit?: (distro: string, cwd: string, args: string[]) => Promise<GitResult>;
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
  status: GitStatus | null;
  shortstat: GitShortstat | null;
  worktrees: GitWorktree[] | null;
  branches: GitBranch[] | null;
  commitsByLimit: Map<number, GitCommit[]>;
  watchers: FSWatcher[];
  debounce: NodeJS.Timeout | null;
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const EMPTY_COUNTS = {
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0
};

export class GitService {
  private readonly caches = new Map<string, RepoCache>();
  private readonly listeners = new Set<(repoPath: string) => void>();

  constructor(private readonly options: GitServiceOptions = {}) {}

  async getStatus(cwd: string, force = false, context: GitRepoContext = {}): Promise<GitStatus> {
    const empty = emptyStatus(cwd);
    const info = await this.resolveRepo(cwd, context);
    if (!info) return empty;
    const cache = this.ensureCache(info);
    if (!force && cache.status) return clone(cache.status);

    const output = await this.runInRepo(info, ['status', '--porcelain=v2', '--branch']);
    if (output.code !== 0) return empty;
    cache.status = parsePorcelainV2(cwd, info.repoPath, output.stdout);
    return clone(cache.status);
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
    const info = await this.resolveRepo(repoPath, context);
    if (!info) return emptyShortstat(repoPath, false);
    const cache = this.ensureCache(info);
    if (!force && cache.shortstat) return clone(cache.shortstat);

    let output = await this.runInRepo(info, ['diff', '--shortstat', 'HEAD', '--']);
    if (output.code !== 0) {
      output = await this.runInRepo(info, ['diff', '--shortstat', '--']);
    }
    const tracked = parseShortstat(output.code === 0 ? output.stdout : '');
    const untracked = await this.countUntracked(info);
    cache.shortstat = {
      repoPath: info.repoPath,
      isRepo: true,
      filesChanged: tracked.filesChanged + untracked.filesChanged,
      insertions: tracked.insertions + untracked.insertions,
      deletions: tracked.deletions
    };
    return clone(cache.shortstat);
  }

  private async countUntracked(
    info: RepoInfo
  ): Promise<{ filesChanged: number; insertions: number }> {
    // git diff --shortstat HEAD only counts tracked files; new files would
    // never show up in the +N -N counter. Run ls-files to enumerate them
    // and treat each one as additions, so the user sees their new code.
    const list = await this.runInRepo(info, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z'
    ]);
    if (list.code !== 0 || !list.stdout) return { filesChanged: 0, insertions: 0 };
    const files = list.stdout.split('\0').filter(Boolean);
    if (files.length === 0) return { filesChanged: 0, insertions: 0 };
    let insertions = 0;
    for (const file of files) {
      // git diff --no-index returns code 1 when files differ (always here),
      // so we read stdout regardless of exit status.
      const result = await this.runInRepo(info, [
        'diff',
        '--no-index',
        '--shortstat',
        '--',
        '/dev/null',
        file
      ]);
      insertions += parseShortstat(result.stdout).insertions;
    }
    return { filesChanged: files.length, insertions };
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
    cache.worktrees = output.code === 0 ? parseWorktrees(output.stdout) : [];
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
    this.invalidate(info.repoPath);
    return this.getStatus(info.repoPath, true, context);
  }

  // List every file with pending working-tree changes (staged + unstaged +
  // untracked), with per-file +/- counts. Untracked files run through
  // `diff --no-index` so a brand-new file shows real insertion totals.
  async listWorkingChanges(
    cwd: string,
    context: GitRepoContext = {}
  ): Promise<WorkingChangesResult> {
    const info = await this.resolveRepo(cwd, context);
    if (!info) return { repoPath: null, isRepo: false, changes: [] };

    const tracked = await this.runInRepo(info, [
      'diff',
      '--no-color',
      '--numstat',
      '-z',
      '--diff-filter=AMDRCT',
      'HEAD'
    ]);
    let trackedEntries: TrackedNumstat[] = [];
    if (tracked.code === 0) {
      trackedEntries = parseNumstatZ(tracked.stdout);
    } else {
      // Repos with no commits yet: HEAD is unresolvable. Fall back to the
      // staged-vs-empty-tree numstat so initial-commit files still show up.
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

    const renameSources = new Set<string>();
    for (const entry of trackedEntries) {
      if (entry.fromPath) renameSources.add(entry.fromPath);
    }

    // Status flags tell us whether each tracked entry is staged, unstaged, or
    // both. We prefer porcelain v1 -z because it gives us the X/Y bytes per
    // path in a parseable way.
    const status = await this.runInRepo(info, ['status', '--porcelain=v1', '-z']);
    const flagByPath = new Map<string, { staged: boolean; unstaged: boolean }>();
    if (status.code === 0) parsePorcelainV1Flags(status.stdout, flagByPath);

    const changes: WorkingChange[] = [];
    for (const entry of trackedEntries) {
      const flags = flagByPath.get(entry.path) ?? { staged: false, unstaged: true };
      changes.push({
        path: entry.path,
        fromPath: entry.fromPath,
        kind: entry.kind,
        staged: flags.staged,
        insertions: entry.insertions,
        deletions: entry.deletions,
        binary: entry.binary
      });
    }

    const untrackedList = await this.runInRepo(info, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z'
    ]);
    if (untrackedList.code === 0 && untrackedList.stdout) {
      const files = untrackedList.stdout.split('\0').filter(Boolean);
      for (const file of files) {
        if (renameSources.has(file)) continue;
        const insertions = await this.untrackedInsertions(info, file);
        changes.push({
          path: file,
          fromPath: null,
          kind: 'untracked',
          staged: false,
          insertions: insertions.lines,
          deletions: 0,
          binary: insertions.binary
        });
      }
    }

    changes.sort((a, b) => a.path.localeCompare(b.path));
    return { repoPath: info.repoPath, isRepo: true, changes };
  }

  async stageFiles(
    cwd: string,
    paths: string[],
    context: GitRepoContext = {}
  ): Promise<void> {
    const info = await this.resolveRepo(cwd, context);
    if (!info || paths.length === 0) return;
    await this.runInRepo(info, ['add', '--', ...paths]);
    this.invalidate(info.repoPath);
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
    this.invalidate(info.repoPath);
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

    this.invalidate(info.repoPath);
  }

  // Fetch a 1-based line range from HEAD's version of the file. Used by
  // the diff viewer to lazily expand collapsed unchanged regions between
  // hunks — the renderer only sends context-around-changes by default to
  // keep payloads small, then fetches more on demand here.
  async getFileLines(
    cwd: string,
    filePath: string,
    startLine: number,
    endLine: number,
    context: GitRepoContext = {}
  ): Promise<{ lines: string[]; totalLines: number }> {
    const info = await this.resolveRepo(cwd, context);
    if (!info) return { lines: [], totalLines: 0 };
    if (!filePath || endLine < 1 || startLine > endLine) {
      return { lines: [], totalLines: 0 };
    }
    const output = await this.runInRepo(info, ['show', `HEAD:${filePath}`]);
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
        empty: true
      };
    }

    const contextLines = Math.max(0, Math.trunc(options.contextLines ?? 3));
    const args = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      `--unified=${contextLines}`,
      'HEAD',
      '--',
      ...(options.fromPath ? [options.fromPath] : []),
      targetPath
    ];

    let output = await this.runInRepo(info, args);
    let mode: 'tracked' | 'untracked-fallback' = 'tracked';

    if (output.code !== 0 || !output.stdout.trim()) {
      // No commit yet, or path is untracked: try the new-file fallback.
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
      const untracked = await this.runInRepo(info, untrackedArgs);
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
      empty: !parsed || parsed.hunks.length === 0
    };
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

  onChange(listener: (repoPath: string) => void): () => void {
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
    this.listeners.clear();
  }

  private async resolveRepo(cwd: string, context: GitRepoContext = {}): Promise<RepoInfo | null> {
    const trimmed = cwd.trim();
    if (!trimmed) return null;
    const nativeInfo = await this.resolveNativeRepo(trimmed);
    if (nativeInfo) return nativeInfo;
    return this.resolveWslRepo(trimmed, context);
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
    const repoPath = toplevel.stdout.trim();
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
    const existing = this.caches.get(info.repoPath);
    if (existing) return existing;
    const cache: RepoCache = {
      info,
      status: null,
      shortstat: null,
      worktrees: null,
      branches: null,
      commitsByLimit: new Map(),
      watchers: [],
      debounce: null
    };
    this.caches.set(info.repoPath, cache);
    this.attachWatchers(cache);
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
        cache.watchers.push(watch(target, { persistent: false }, () => this.invalidate(cache.info.repoPath)));
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

  private invalidate(repoPath: string): void {
    const cache = this.caches.get(repoPath);
    if (!cache) return;
    cache.status = null;
    cache.shortstat = null;
    cache.worktrees = null;
    cache.branches = null;
    cache.commitsByLimit.clear();
    if (cache.debounce) clearTimeout(cache.debounce);
    cache.debounce = setTimeout(() => {
      cache.debounce = null;
      for (const listener of this.listeners) {
        try {
          listener(repoPath);
        } catch {
          // listener errors are isolated
        }
      }
    }, 150);
  }

  private async gitBinary(): Promise<string> {
    if (this.options.getGitBinary) {
      const configured = await this.options.getGitBinary();
      if (configured) return configured;
    }
    return this.options.gitBinary ?? 'git';
  }

  private async run(cwd: string, args: string[]): Promise<GitResult> {
    return runGit(await this.gitBinary(), cwd, args);
  }

  private async runInRepo(info: RepoInfo, args: string[]): Promise<GitResult> {
    if (info.runMode === 'wsl') return this.runWsl(info.wslDistro!, info.repoPath, args);
    return this.run(info.repoPath, args);
  }

  private async runWsl(distro: string, cwd: string, args: string[]): Promise<GitResult> {
    if (this.options.runWslGit) return this.options.runWslGit(distro, cwd, args);
    return runWslGit(this.options.wslBinary ?? 'wsl.exe', distro, cwd, args);
  }
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

function parsePorcelainV2(cwd: string, repoPath: string, output: string): GitStatus {
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
  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      if (oid && oid !== '(initial)') status.head = oid;
      continue;
    }
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') {
        status.detached = true;
      } else {
        status.branch = head;
      }
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const rest = line.slice('# branch.ab '.length).trim();
      const match = rest.match(/\+(-?\d+)\s+-(-?\d+)/);
      if (match) {
        status.ahead = Number(match[1] ?? 0);
        status.behind = Number(match[2] ?? 0);
      }
      continue;
    }
    if (line.startsWith('?')) {
      status.untracked += 1;
      continue;
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      const x = xy[0];
      const y = xy[1];
      if (x && x !== '.') status.staged += 1;
      if (y && y !== '.') status.unstaged += 1;
    }
  }
  status.dirty = status.staged > 0 || status.unstaged > 0 || status.untracked > 0;
  return status;
}

function parseShortstat(output: string): Omit<GitShortstat, 'repoPath' | 'isRepo'> {
  const files = output.match(/(\d+)\s+files?\s+changed/);
  const insertions = output.match(/(\d+)\s+insertions?\(\+\)/);
  const deletions = output.match(/(\d+)\s+deletions?\(-\)/);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0
  };
}

function parseWorktrees(output: string): GitWorktree[] {
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
        path: line.slice('worktree '.length),
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

function runGit(bin: string, cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(bin, args, { cwd });
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => finish({ code: null, stdout, stderr: String(err) }));
    child.on('exit', (code) => finish({ code, stdout, stderr }));
  });
}

function runWslGit(
  wslBinary: string,
  distro: string,
  cwd: string,
  args: string[]
): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(
      wslBinary,
      ['-d', distro, '--cd', cwd, '--', 'git', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => finish({ code: null, stdout, stderr: String(err) }));
    child.on('exit', (code) => finish({ code, stdout, stderr }));
  });
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

function parsePorcelainV1Flags(
  output: string,
  out: Map<string, { staged: boolean; unstaged: boolean }>
): void {
  // Format: XY<space><path>NUL, with rename entries spelled
  // XY<space><to>NUL<from>NUL.
  const tokens = output.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i];
    if (!record) {
      i += 1;
      continue;
    }
    if (record.length < 4) {
      i += 1;
      continue;
    }
    const x = record[0]!;
    const y = record[1]!;
    const filePath = record.slice(3);
    const isRename = x === 'R' || y === 'R' || x === 'C' || y === 'C';
    const stageStaged = x !== ' ' && x !== '?' && x !== '!';
    const stageUnstaged = y !== ' ' && y !== '?' && y !== '!';
    out.set(filePath, { staged: stageStaged, unstaged: stageUnstaged });
    i += 1;
    if (isRename) {
      // Drop the from-path token; the renamed entry is keyed by destination.
      i += 1;
    }
  }
}

interface ParsedDiff {
  fromPath: string | null;
  kind: WorkingChangeKind;
  binary: boolean;
  hunks: DiffHunk[];
}

function parseUnifiedDiff(text: string): ParsedDiff | null {
  if (!text) return null;
  const lines = text.split('\n');
  let fromPath: string | null = null;
  let kind: WorkingChangeKind = 'modified';
  let binary = false;
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;
  let sawHeader = false;

  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      sawHeader = true;
      continue;
    }
    if (!sawHeader && raw.startsWith('--- ')) sawHeader = true;
    if (raw.startsWith('new file mode')) kind = 'added';
    else if (raw.startsWith('deleted file mode')) kind = 'deleted';
    else if (raw.startsWith('rename from ')) {
      fromPath = raw.slice('rename from '.length);
      kind = 'renamed';
    } else if (raw.startsWith('copy from ')) {
      fromPath = raw.slice('copy from '.length);
      kind = 'copied';
    } else if (raw.startsWith('Binary files') || raw.includes('GIT binary patch')) {
      binary = true;
    }

    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (!match) continue;
      const oldStart = Number(match[1] ?? 0);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3] ?? 0);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      current = {
        header: (match[5] ?? '').trim(),
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: []
      };
      hunks.push(current);
      oldCursor = oldStart;
      newCursor = newStart;
      continue;
    }

    if (!current) continue;

    const head = raw[0];
    if (head === '+' && !raw.startsWith('+++')) {
      current.lines.push(makeLine('add', null, newCursor, raw.slice(1)));
      newCursor += 1;
    } else if (head === '-' && !raw.startsWith('---')) {
      current.lines.push(makeLine('remove', oldCursor, null, raw.slice(1)));
      oldCursor += 1;
    } else if (head === '\\') {
      // "\ No newline at end of file" — annotate as meta on current pair.
      current.lines.push(makeLine('meta', null, null, raw));
    } else if (head === ' ' || raw === '') {
      const ctx = head === ' ' ? raw.slice(1) : '';
      current.lines.push(makeLine('context', oldCursor, newCursor, ctx));
      oldCursor += 1;
      newCursor += 1;
    }
  }

  if (!sawHeader && hunks.length === 0 && !binary) return null;
  return { fromPath, kind, binary, hunks };
}

function makeLine(
  kind: DiffLineKind,
  oldLine: number | null,
  newLine: number | null,
  text: string
): DiffLine {
  return { kind, oldLine, newLine, text };
}
