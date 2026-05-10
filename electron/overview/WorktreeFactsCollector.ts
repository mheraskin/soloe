import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  WorktreeDirtyFile,
  WorktreeFacts,
  WorktreeRecentCommit
} from '@shared/types/overview.js';
import type { RunMode } from '@shared/types/sessions.js';

const RECENT_COMMITS_LIMIT = 30;
const WORKING_DIFF_BYTES = 200_000;

export type GitRunner = (
  cwd: string,
  args: string[]
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface FactsScope {
  runMode?: RunMode;
  wslDistro?: string;
}

export interface WorktreeFactsCollectorOptions {
  runGit?: GitRunner;
  gitBinary?: string;
}

export class WorktreeFactsCollector {
  private readonly injectedRunGit: GitRunner | undefined;
  private readonly gitBinary: string;

  constructor(opts: WorktreeFactsCollectorOptions = {}) {
    this.injectedRunGit = opts.runGit;
    this.gitBinary = opts.gitBinary ?? 'git';
  }

  async collect(cwd: string, requestedBase?: string, scope?: FactsScope): Promise<WorktreeFacts> {
    const runGit = this.buildRunner(scope);
    const [head, branch] = await Promise.all([
      this.runText(runGit, cwd, ['rev-parse', 'HEAD']),
      this.runText(runGit, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ]);

    const baseBranch = await this.resolveBase(runGit, cwd, branch, requestedBase);

    let commitsAhead = 0;
    let commitsBehind = 0;
    let aheadShas: string[] = [];
    if (baseBranch) {
      const [aheadList, behindCount] = await Promise.all([
        this.runText(runGit, cwd, ['log', `${baseBranch}..HEAD`, '--pretty=format:%H']),
        this.runText(runGit, cwd, ['rev-list', '--count', `HEAD..${baseBranch}`])
      ]);
      aheadShas = aheadList.split('\n').map((s) => s.trim()).filter(Boolean);
      commitsAhead = aheadShas.length;
      commitsBehind = parseInt(behindCount.trim(), 10) || 0;
    }

    const pushedAhead = await this.checkPushed(runGit, cwd, aheadShas);
    const mergedIntoBase = baseBranch && head
      ? await this.checkMergedIntoBase(runGit, cwd, head, baseBranch)
      : false;

    const dirtyFiles = await this.collectDirtyFiles(runGit, cwd);
    const dirtyHash = hashDirty(dirtyFiles);

    const workingDiff = await this.collectWorkingDiff(runGit, cwd);
    const recentCommits = await this.collectRecentCommits(runGit, cwd, baseBranch, aheadShas);

    return {
      cwd,
      branch: branch.trim() || null,
      head: head.trim() || null,
      baseBranch,
      commitsAhead,
      commitsBehind,
      commitsAheadShas: aheadShas,
      pushedAhead,
      mergedIntoBase,
      dirtyFiles,
      dirtyHash,
      workingDiff,
      recentCommits
    };
  }

  // Runner factory: tests inject their own; production builds a scope-aware
  // spawner. In WSL mode git runs inside the distro (so it sees the WSL
  // filesystem and the user's git config); otherwise it spawns directly.
  private buildRunner(scope?: FactsScope): GitRunner {
    if (this.injectedRunGit) return this.injectedRunGit;
    if (scope?.runMode === 'wsl') {
      return wslGitRunner(scope.wslDistro ?? 'Ubuntu');
    }
    return defaultGitRunner(this.gitBinary);
  }

  private async resolveBase(
    runGit: GitRunner,
    cwd: string,
    currentBranch: string,
    requested?: string
  ): Promise<string | null> {
    const branch = currentBranch.trim();
    if (requested) return requested;
    const upstream = await this.runText(runGit, cwd, [
      'rev-parse',
      '--abbrev-ref',
      `${branch || 'HEAD'}@{upstream}`
    ]).catch(() => '');
    if (upstream && !upstream.startsWith('fatal')) return upstream.trim();
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      const exists = await runGit(cwd, ['rev-parse', '--verify', candidate]);
      if (exists.code === 0 && exists.stdout.trim()) return candidate;
    }
    return null;
  }

  private async checkPushed(runGit: GitRunner, cwd: string, shas: string[]): Promise<boolean> {
    if (shas.length === 0) return true;
    const result = await runGit(cwd, [
      'branch',
      '--remotes',
      '--contains',
      shas[0]!
    ]);
    if (result.code !== 0) return false;
    return result.stdout.trim().length > 0;
  }

  private async checkMergedIntoBase(
    runGit: GitRunner,
    cwd: string,
    head: string,
    base: string
  ): Promise<boolean> {
    const result = await runGit(cwd, ['merge-base', '--is-ancestor', head, base]);
    return result.code === 0;
  }

  private async collectDirtyFiles(runGit: GitRunner, cwd: string): Promise<WorktreeDirtyFile[]> {
    const result = await runGit(cwd, ['status', '--porcelain=v1', '-z']);
    if (result.code !== 0) return [];
    const files: WorktreeDirtyFile[] = [];
    const records = result.stdout.split('\0').filter(Boolean);
    for (const rec of records) {
      if (rec.length < 3) continue;
      const x = rec[0] ?? ' ';
      const y = rec[1] ?? ' ';
      const filePath = rec.slice(3);
      if (x === '?' && y === '?') {
        files.push({ path: filePath, status: 'untracked', kind: '?' });
        continue;
      }
      if (x !== ' ' && x !== '?') {
        files.push({
          path: filePath,
          status: 'staged',
          kind: normalizeStatusKind(x)
        });
      }
      if (y !== ' ' && y !== '?') {
        files.push({
          path: filePath,
          status: 'unstaged',
          kind: normalizeStatusKind(y)
        });
      }
    }
    return files;
  }

  private async collectWorkingDiff(runGit: GitRunner, cwd: string): Promise<string> {
    const tracked = await this.runText(runGit, cwd, ['diff', 'HEAD', '--no-color']);
    if (tracked.length >= WORKING_DIFF_BYTES) {
      return tracked.slice(0, WORKING_DIFF_BYTES) + `\n…[truncated, full diff was ${tracked.length} bytes]`;
    }
    return tracked;
  }

  private async collectRecentCommits(
    runGit: GitRunner,
    cwd: string,
    baseBranch: string | null,
    aheadShas: string[]
  ): Promise<WorktreeRecentCommit[]> {
    const ahead = new Set(aheadShas);
    const result = await runGit(cwd, [
      'log',
      `-${RECENT_COMMITS_LIMIT}`,
      '--pretty=format:%H%x1f%h%x1f%s%x1f%aI'
    ]);
    if (result.code !== 0) return [];
    const lines = result.stdout.split('\n').filter(Boolean);
    const commits: WorktreeRecentCommit[] = [];
    for (const line of lines) {
      const [sha, shortSha, subject, authorDate] = line.split('\x1f');
      if (!sha || !shortSha) continue;
      const isAhead = ahead.has(sha);
      let pushed = false;
      let mergedIntoBase = false;
      if (isAhead) {
        const branches = await runGit(cwd, ['branch', '--remotes', '--contains', sha]);
        pushed = branches.code === 0 && branches.stdout.trim().length > 0;
      } else {
        pushed = true;
      }
      if (baseBranch) {
        const merged = await runGit(cwd, ['merge-base', '--is-ancestor', sha, baseBranch]);
        mergedIntoBase = merged.code === 0;
      }
      commits.push({
        sha,
        shortSha,
        subject: subject ?? '',
        authorDate: authorDate ?? '',
        pushed,
        mergedIntoBase
      });
    }
    return commits;
  }

  private async runText(runGit: GitRunner, cwd: string, args: string[]): Promise<string> {
    const result = await runGit(cwd, args);
    if (result.code !== 0) return '';
    return result.stdout;
  }
}

function normalizeStatusKind(ch: string): WorktreeDirtyFile['kind'] {
  switch (ch) {
    case 'A':
    case 'M':
    case 'D':
    case 'R':
    case 'C':
    case 'T':
    case '?':
      return ch;
    default:
      return 'M';
  }
}

function hashDirty(files: WorktreeDirtyFile[]): string {
  const sorted = [...files].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.status.localeCompare(b.status);
  });
  const fingerprint = sorted.map((f) => `${f.status}:${f.kind}:${f.path}`).join('\n');
  return createHash('sha1').update(fingerprint).digest('hex');
}

function defaultGitRunner(gitBinary: string): GitRunner {
  return (cwd, args) =>
    new Promise((resolve) => {
      const child = spawn(gitBinary, args, { cwd, env: process.env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (err) => {
        resolve({ code: null, stdout, stderr: stderr || err.message });
      });
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });
}

// In WSL mode the worktree lives inside the distro, so git must run there
// too — running it from the Windows side would either fail to find the
// repo (Linux paths don't resolve to a Windows directory) or report config
// from the Windows git install instead of the user's WSL git.
function wslGitRunner(distro: string): GitRunner {
  return (cwd, args) =>
    new Promise((resolve) => {
      const wslArgs = ['-d', distro, '--cd', cwd, '--', 'git', ...args];
      const child = spawn('wsl.exe', wslArgs, { env: process.env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (err) => {
        resolve({ code: null, stdout, stderr: stderr || err.message });
      });
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });
}
