import type { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type {
  WorktreeDirtyFile,
  WorktreeFacts,
  WorktreeRecentCommit
} from '@shared/types/overview.js';
import type { RunMode } from '@shared/types/sessions.js';
import {
  NativeGitEvidenceAdapter,
  WORKING_DIFF_PREVIEW_BYTES,
  WslGitEvidenceAdapter,
  type GitCommandResult,
  type GitEvidenceAdapter
} from './GitEvidenceAdapter.js';

export interface FactsScope {
  runMode?: RunMode;
  wslDistro?: string;
}

export interface WorktreeFactsCollectorOptions {
  gitBinary?: string;
  getGitBinary?: () => Promise<string | undefined> | string | undefined;
  spawnImpl?: typeof spawn;
  wslBinary?: string;
  createAdapter?: (scope?: FactsScope) => GitEvidenceAdapter;
  useWslHostBridge?: boolean;
}

/**
 * Turns runtime-specific raw Git evidence into the stable Worktree Evidence
 * facts consumed by overview prompts and cache validation.
 */
export class WorktreeFactsCollector {
  private readonly gitBinary: string;
  private readonly getGitBinary: (() => Promise<string | undefined>) | undefined;
  private readonly spawnImpl: typeof spawn | undefined;
  private readonly wslBinary: string | undefined;
  private readonly createAdapter: ((scope?: FactsScope) => GitEvidenceAdapter) | undefined;
  private readonly useWslHostBridge: boolean;

  constructor(opts: WorktreeFactsCollectorOptions = {}) {
    this.gitBinary = opts.gitBinary ?? 'git';
    this.getGitBinary = opts.getGitBinary
      ? async () => opts.getGitBinary!()
      : undefined;
    this.spawnImpl = opts.spawnImpl;
    this.wslBinary = opts.wslBinary;
    this.createAdapter = opts.createAdapter;
    this.useWslHostBridge =
      opts.useWslHostBridge ??
      (process.platform === 'win32' || Boolean(opts.wslBinary || opts.spawnImpl));
  }

  async collect(cwd: string, requestedBase?: string, scope?: FactsScope): Promise<WorktreeFacts> {
    const raw = await (await this.buildAdapter(scope)).collect(cwd, requestedBase);
    const diagnostics: string[] = [];
    const headText = requiredText(raw.head, 'resolve HEAD', diagnostics);
    const head = isGitOid(headText) ? headText : null;
    if (headText && !head) diagnostics.push('resolve HEAD: git returned an invalid commit OID');
    const branch = requiredText(raw.branch, 'resolve branch', diagnostics) || null;
    if (raw.baseError) diagnostics.push(raw.baseError);
    const base = raw.base;

    let aheadShas: string[] = [];
    let commitsBehind = 0;
    if (base && head) {
      aheadShas = requiredText(raw.ahead, 'classify commits ahead', diagnostics)
        .split('\n').map((sha) => sha.trim()).filter(Boolean);
      commitsBehind = Number.parseInt(
        requiredText(raw.behind, 'count commits behind', diagnostics).trim(),
        10
      ) || 0;
    }

    const unpushedRecent = head
      ? new Set(
          requiredText(raw.unpushed, 'classify remote reachability', diagnostics)
            .split('\n').map((sha) => sha.trim()).filter(Boolean)
        )
      : new Set<string>();
    const pushedAhead = aheadShas.length === 0 || !unpushedRecent.has(aheadShas[0]!);
    const mergedIntoBase = Boolean(base && head && !new Set(aheadShas).has(head));

    const statusText = requiredText(raw.status, 'read worktree status', diagnostics, false);
    const dirtyFiles = parseDirtyFiles(statusText);
    const fullDiff = head
      ? requiredText(raw.diff, 'read working diff', diagnostics, false)
      : '';
    const dirtyHash = hashDirty(dirtyFiles, raw.diffFullHash || hashText(fullDiff));
    const workingDiff = truncateWorkingDiff(fullDiff, raw.diffFullByteLength);
    const recentCommits = head
      ? parseRecentCommits(
          requiredText(raw.recent, 'read recent commits', diagnostics, false),
          base?.oid ?? null,
          aheadShas,
          unpushedRecent
        )
      : [];
    const evidenceFingerprint = hashEvidence({
      cwd,
      branch,
      head,
      baseLabel: base?.label ?? null,
      baseOid: base?.oid ?? null,
      aheadShas,
      commitsBehind,
      pushedAhead,
      dirtyHash,
      recentCommits
    });

    return {
      cwd,
      branch,
      head,
      baseBranch: base?.label ?? null,
      baseOid: base?.oid ?? null,
      commitsAhead: aheadShas.length,
      commitsBehind,
      commitsAheadShas: aheadShas,
      pushedAhead,
      mergedIntoBase,
      dirtyFiles,
      dirtyHash,
      evidenceFingerprint,
      completeness: diagnostics.length === 0 ? 'complete' : 'degraded',
      diagnostics,
      workingDiff,
      recentCommits
    };
  }

  private async buildAdapter(scope?: FactsScope): Promise<GitEvidenceAdapter> {
    if (this.createAdapter) return this.createAdapter(scope);
    if (scope?.runMode === 'wsl' && this.useWslHostBridge) {
      return new WslGitEvidenceAdapter(scope.wslDistro ?? 'Ubuntu', {
        ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}),
        ...(this.wslBinary ? { wslBinary: this.wslBinary } : {})
      });
    }
    return new NativeGitEvidenceAdapter({
      gitBinary: (await this.getGitBinary?.()) ?? this.gitBinary,
      ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {})
    });
  }
}

function requiredText(
  result: GitCommandResult,
  label: string,
  diagnostics: string[],
  trim = true
): string {
  if (result.code !== 0) {
    diagnostics.push(`${label}: ${describeFailure(result)}`);
    return '';
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function parseDirtyFiles(output: string): WorktreeDirtyFile[] {
  const files: WorktreeDirtyFile[] = [];
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const rec = records[index] ?? '';
    if (!rec || rec.startsWith('# ') || rec.startsWith('! ')) continue;
    if (rec.startsWith('? ')) {
      files.push({ path: rec.slice(2), status: 'untracked', kind: '?' });
      continue;
    }
    const recordType = rec[0];
    if (recordType !== '1' && recordType !== '2') continue;
    const fields = rec.split(' ');
    const xy = fields[1] ?? '..';
    const x = xy[0] ?? '.';
    const y = xy[1] ?? '.';
    const pathIndex = recordType === '2' ? 9 : 8;
    const filePath = fields.slice(pathIndex).join(' ');
    // Type 2 is followed by the original path as a separate NUL record.
    if (recordType === '2') index += 1;
    if (x !== ' ' && x !== '?' && x !== '.') {
      files.push({ path: filePath, status: 'staged', kind: normalizeStatusKind(x) });
    }
    if (y !== ' ' && y !== '?' && y !== '.') {
      files.push({ path: filePath, status: 'unstaged', kind: normalizeStatusKind(y) });
    }
  }
  return files;
}

function parseRecentCommits(
  output: string,
  baseOid: string | null,
  aheadShas: string[],
  unpushedRecent: Set<string>
): WorktreeRecentCommit[] {
  const ahead = new Set(aheadShas);
  const commits: WorktreeRecentCommit[] = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const [sha, shortSha, subject, authorDate] = line.split('\x1f');
    if (!sha || !shortSha) continue;
    const isAhead = ahead.has(sha);
    commits.push({
      sha,
      shortSha,
      subject: subject ?? '',
      authorDate: authorDate ?? '',
      pushed: isAhead ? !unpushedRecent.has(sha) : true,
      mergedIntoBase: baseOid ? !isAhead : false
    });
  }
  return commits;
}

function truncateWorkingDiff(diff: string, fullByteLength: number): string {
  if (fullByteLength <= WORKING_DIFF_PREVIEW_BYTES) return diff;
  return diff + `\n…[truncated, full diff was ${fullByteLength} bytes]`;
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

function hashDirty(files: WorktreeDirtyFile[], fullDiffHash: string): string {
  const sorted = [...files].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.status.localeCompare(b.status);
  });
  const fingerprint = sorted.map((file) =>
    `${file.status}:${file.kind}:${file.path}`).join('\n');
  return hashText(`${fingerprint}\0${fullDiffHash}`);
}

function hashEvidence(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function isGitOid(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value);
}

function describeFailure(result: GitCommandResult): string {
  return result.stderr.trim().split('\n')[0] || `git exited with code ${String(result.code)}`;
}
