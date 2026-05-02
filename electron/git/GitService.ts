import { spawn } from 'node:child_process';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import type {
  GitAheadBehind,
  GitBranch,
  GitCommit,
  GitDirty,
  GitShortstat,
  GitStatus,
  GitWorktree
} from '@shared/types/git.js';

export interface GitServiceOptions {
  gitBinary?: string;
  getGitBinary?: () => Promise<string | undefined> | string | undefined;
}

interface RepoInfo {
  repoPath: string;
  gitDir: string;
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

  async getStatus(cwd: string, force = false): Promise<GitStatus> {
    const empty = emptyStatus(cwd);
    const info = await this.resolveRepo(cwd);
    if (!info) return empty;
    const cache = this.ensureCache(info);
    if (!force && cache.status) return clone(cache.status);

    const output = await this.run(info.repoPath, ['status', '--porcelain=v2', '--branch']);
    if (output.code !== 0) return empty;
    cache.status = parsePorcelainV2(cwd, info.repoPath, output.stdout);
    return clone(cache.status);
  }

  async getBranch(repoPath: string): Promise<string | null> {
    const status = await this.getStatus(repoPath);
    return status.detached ? null : status.branch;
  }

  async getShortstat(repoPath: string, force = false): Promise<GitShortstat> {
    const info = await this.resolveRepo(repoPath);
    if (!info) return emptyShortstat(repoPath, false);
    const cache = this.ensureCache(info);
    if (!force && cache.shortstat) return clone(cache.shortstat);

    let output = await this.run(info.repoPath, ['diff', '--shortstat', 'HEAD', '--']);
    if (output.code !== 0) {
      output = await this.run(info.repoPath, ['diff', '--shortstat', '--']);
    }
    cache.shortstat = {
      repoPath: info.repoPath,
      isRepo: true,
      ...parseShortstat(output.code === 0 ? output.stdout : '')
    };
    return clone(cache.shortstat);
  }

  async getAheadBehind(repoPath: string, force = false): Promise<GitAheadBehind> {
    const status = await this.getStatus(repoPath, force);
    return {
      repoPath: status.repoPath ?? repoPath,
      isRepo: status.isRepo,
      ahead: status.ahead,
      behind: status.behind
    };
  }

  async getDirty(repoPath: string, force = false): Promise<GitDirty> {
    const status = await this.getStatus(repoPath, force);
    return {
      repoPath: status.repoPath ?? repoPath,
      isRepo: status.isRepo,
      dirty: status.dirty,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked
    };
  }

  async listWorktrees(repoPath: string, force = false): Promise<GitWorktree[]> {
    const info = await this.resolveRepo(repoPath);
    if (!info) return [];
    const cache = this.ensureCache(info);
    if (!force && cache.worktrees) return clone(cache.worktrees);
    const output = await this.run(info.repoPath, ['worktree', 'list', '--porcelain']);
    cache.worktrees = output.code === 0 ? parseWorktrees(output.stdout) : [];
    return clone(cache.worktrees);
  }

  async listLocalBranches(repoPath: string, force = false): Promise<GitBranch[]> {
    const info = await this.resolveRepo(repoPath);
    if (!info) return [];
    const cache = this.ensureCache(info);
    if (!force && cache.branches) return clone(cache.branches);
    const output = await this.run(info.repoPath, [
      'branch',
      '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(committerdate:iso8601)%00%(subject)'
    ]);
    cache.branches = output.code === 0 ? parseBranches(output.stdout) : [];
    return clone(cache.branches);
  }

  async listRecentCommits(repoPath: string, limit = 20, force = false): Promise<GitCommit[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const info = await this.resolveRepo(repoPath);
    if (!info) return [];
    const cache = this.ensureCache(info);
    const cached = cache.commitsByLimit.get(safeLimit);
    if (!force && cached) return clone(cached);
    const output = await this.run(info.repoPath, [
      'log',
      `-${safeLimit}`,
      '--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s'
    ]);
    const commits = output.code === 0 ? parseCommits(output.stdout) : [];
    cache.commitsByLimit.set(safeLimit, commits);
    return clone(commits);
  }

  async checkout(repoPath: string, ref: string, force = false): Promise<GitStatus> {
    const target = ref.trim();
    if (!target) throw new Error('Checkout ref is required');
    const info = await this.resolveRepo(repoPath);
    if (!info) throw new Error(`Not a git repository: ${repoPath}`);
    if (!force) {
      const dirty = await this.getDirty(info.repoPath, true);
      if (dirty.dirty) {
        throw new Error('Repository has uncommitted changes');
      }
    }
    const args = force ? ['checkout', '-f', target] : ['checkout', target];
    const output = await this.run(info.repoPath, args);
    if (output.code !== 0) {
      throw new Error(output.stderr.trim() || `Failed to check out ${target}`);
    }
    this.invalidate(info.repoPath);
    return this.getStatus(info.repoPath, true);
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

  private async resolveRepo(cwd: string): Promise<RepoInfo | null> {
    const trimmed = cwd.trim();
    if (!trimmed) return null;
    try {
      const stat = await fs.stat(trimmed);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
    const toplevel = await this.run(trimmed, ['rev-parse', '--show-toplevel']);
    if (toplevel.code !== 0) return null;
    const repoPath = toplevel.stdout.trim();
    if (!repoPath) return null;
    const gitDirResult = await this.run(repoPath, ['rev-parse', '--git-dir']);
    if (gitDirResult.code !== 0) return null;
    const rawGitDir = gitDirResult.stdout.trim();
    const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(repoPath, rawGitDir);
    return { repoPath, gitDir };
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
}

function emptyStatus(cwd: string): GitStatus {
  return {
    cwd,
    repoPath: null,
    isRepo: false,
    branch: null,
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
    detached: false,
    dirty: false,
    ...EMPTY_COUNTS
  };
  for (const line of output.split('\n')) {
    if (!line) continue;
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
