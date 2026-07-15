import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { SHARED_GIT_PROCESS_EXECUTOR } from '../git/GitProcessExecutor.js';

export interface GitCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (
  cwd: string,
  args: string[],
  signal?: AbortSignal
) => Promise<GitCommandResult>;

export interface GitPatchCapture {
  result: GitCommandResult;
  fullHash: string;
  fullByteLength: number;
}

export type GitPatchRunner = (
  cwd: string,
  args: string[],
  signal?: AbortSignal
) => Promise<GitPatchCapture>;

export interface RawGitEvidence {
  head: GitCommandResult;
  branch: GitCommandResult;
  base: { label: string; oid: string } | null;
  baseError?: string;
  ahead: GitCommandResult;
  behind: GitCommandResult;
  unpushed: GitCommandResult;
  status: GitCommandResult;
  diff: GitCommandResult;
  diffFullHash: string;
  diffFullByteLength: number;
  recent: GitCommandResult;
}

/**
 * Runtime Adapter at the Worktree Evidence Seam. One call must describe one
 * OID-anchored generation; process topology is an Implementation detail.
 */
export interface GitEvidenceAdapter {
  collect(cwd: string, requestedBase?: string): Promise<RawGitEvidence>;
}

export interface NativeGitEvidenceAdapterOptions {
  gitBinary?: string;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  maxCommandBytes?: number;
  runGit?: GitCommandRunner;
  runPatch?: GitPatchRunner;
}

const DEFAULT_NATIVE_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_NATIVE_COMMAND_BYTES = 5 * 1024 * 1024;
const MAX_NATIVE_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_STDERR_BYTES = 64 * 1024;
const STDERR_TRUNCATED_MARKER = Buffer.from('\n…[stderr truncated]', 'utf8');

export class NativeGitEvidenceAdapter implements GitEvidenceAdapter {
  private readonly runGit: GitCommandRunner;
  private readonly runPatch: GitPatchRunner;
  private readonly timeoutMs: number;

  constructor(options: NativeGitEvidenceAdapterOptions = {}) {
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_NATIVE_GIT_TIMEOUT_MS);
    this.timeoutMs = timeoutMs;
    const maxCommandBytes = positiveInteger(
      options.maxCommandBytes,
      DEFAULT_NATIVE_COMMAND_BYTES
    );
    if (Boolean(options.runGit) !== Boolean(options.runPatch)) {
      throw new Error('NativeGitEvidenceAdapter requires runGit and runPatch together');
    }
    const config = {
      gitBinary: options.gitBinary ?? 'git',
      spawnImpl: options.spawnImpl ?? spawn,
      timeoutMs,
      maxCommandBytes,
      budget: new NativeCaptureBudget(MAX_NATIVE_EVIDENCE_BYTES)
    };
    this.runGit = options.runGit ?? createBoundedGitRunner(config);
    this.runPatch = options.runPatch ?? createStreamingPatchRunner(config);
  }

  async collect(cwd: string, requestedBase?: string): Promise<RawGitEvidence> {
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(`native Git evidence timed out after ${this.timeoutMs}ms`);
    }, this.timeoutMs);
    try {
      return await this.collectGeneration(cwd, requestedBase, controller.signal);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async collectGeneration(
    cwd: string,
    requestedBase: string | undefined,
    signal: AbortSignal
  ): Promise<RawGitEvidence> {
    const [head, branch] = await Promise.all([
      this.runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], signal),
      this.runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)
    ]);
    const headOid = successfulOid(head);
    const resolvedBase = await this.resolveBase(
      cwd,
      successfulText(branch),
      requestedBase,
      signal
    );
    const base = resolvedBase.base;
    const [ahead, behind] = base && headOid
      ? await Promise.all([
          this.runGit(cwd, ['rev-list', `${base.oid}..${headOid}`], signal),
          this.runGit(cwd, ['rev-list', '--count', `${headOid}..${base.oid}`], signal)
        ])
      : [ok(), ok()];
    const [unpushed, status] = await Promise.all([
      headOid
        ? this.runGit(
            cwd,
            ['rev-list', '--max-count=30', headOid, '--not', '--remotes'],
            signal
          )
        : ok(),
      this.runGit(cwd, [
        'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'
      ], signal)
    ]);
    const [patch, recent] = await Promise.all([
      headOid
        ? this.runPatch(cwd, [
            'diff', headOid, '--no-color', '--no-ext-diff', '--no-textconv'
          ], signal)
        : emptyPatch(),
      headOid
        ? this.runGit(cwd, [
            'log', '-30', headOid,
            '--pretty=format:%H%x1f%h%x1f%s%x1f%aI'
          ], signal)
        : ok()
    ]);
    return {
      head,
      branch,
      base,
      ...(resolvedBase.error ? { baseError: resolvedBase.error } : {}),
      ahead,
      behind,
      unpushed,
      status,
      diff: patch.result,
      diffFullHash: patch.fullHash,
      diffFullByteLength: patch.fullByteLength,
      recent
    };
  }

  private async resolveBase(
    cwd: string,
    currentBranch: string,
    requested: string | undefined,
    signal: AbortSignal
  ): Promise<{ base: RawGitEvidence['base']; error?: string }> {
    const explicit = requested?.trim();
    if (explicit) {
      const result = await this.runGit(cwd, [
        'rev-parse', '--verify', '--end-of-options', `${explicit}^{commit}`
      ], signal);
      const oid = successfulOid(result);
      return oid
        ? { base: { label: explicit, oid } }
        : { base: null, error: `resolve requested base ${explicit}: ${describeFailure(result)}` };
    }

    const branch = currentBranch.trim() || 'HEAD';
    const upstreamResult = await this.runGit(cwd, [
      'rev-parse', '--abbrev-ref', `${branch}@{upstream}`
    ], signal);
    const upstream = successfulText(upstreamResult);
    if (upstream) {
      const result = await this.runGit(cwd, [
        'rev-parse', '--verify', '--end-of-options', `${upstream}^{commit}`
      ], signal);
      const oid = successfulOid(result);
      if (oid) return { base: { label: upstream, oid } };
    }
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      const result = await this.runGit(cwd, [
        'rev-parse', '--verify', '--end-of-options', `${candidate}^{commit}`
      ], signal);
      const oid = successfulOid(result);
      if (oid) return { base: { label: candidate, oid } };
    }
    return { base: null };
  }
}

interface NativeRunnerConfig {
  gitBinary: string;
  spawnImpl: typeof spawn;
  timeoutMs: number;
  maxCommandBytes?: number;
  budget: NativeCaptureBudget;
}

class NativeCaptureBudget {
  private retainedBytes = 0;

  constructor(private readonly limit: number) {}

  tryRetain(bytes: number): boolean {
    if (this.retainedBytes + bytes > this.limit) return false;
    this.retainedBytes += bytes;
    return true;
  }
}

const PROCESS_KILL_GRACE_MS = 25;

function createBoundedGitRunner(config: NativeRunnerConfig): GitCommandRunner {
  const maxCommandBytes = config.maxCommandBytes ?? DEFAULT_NATIVE_COMMAND_BYTES;
  return async (cwd, args, signal) => {
    const release = await SHARED_GIT_PROCESS_EXECUTOR.acquire(signal);
    if (!release) return failed(abortReason(signal, config.timeoutMs));
    try {
      return await new Promise<GitCommandResult>((resolve) => {
        if (signal?.aborted) {
          resolve(failed(abortReason(signal, config.timeoutMs)));
          return;
        }
        const child = config.spawnImpl(config.gitBinary, args, {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrSeenBytes = 0;
        let settled = false;
        let terminationMessage: string | null = null;
        let killGrace: NodeJS.Timeout | null = null;
        const cleanup = () => {
          clearTimeout(timer);
          if (killGrace) clearTimeout(killGrace);
          signal?.removeEventListener('abort', onAbort);
          child.stdout?.removeListener('data', onStdout);
          child.stderr?.removeListener('data', onStderr);
          child.removeListener('error', onError);
          child.removeListener('close', onClose);
          child.stdout?.destroy();
          child.stderr?.destroy();
        };
        const finish = (result: GitCommandResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const terminate = (message: string) => {
          if (settled || terminationMessage) return;
          terminationMessage = message;
          clearTimeout(timer);
          child.stdout?.removeListener('data', onStdout);
          child.stderr?.removeListener('data', onStderr);
          try { child.kill(); } catch { /* best effort */ }
          if (!settled) {
            killGrace = setTimeout(() => finish(failed(message)), PROCESS_KILL_GRACE_MS);
          }
        };
        const onAbort = () => terminate(abortReason(signal, config.timeoutMs));
        const onStdout = (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxCommandBytes) {
            terminate(`native Git command output exceeded ${maxCommandBytes} bytes`);
            return;
          }
          if (!config.budget.tryRetain(chunk.length)) {
            terminate(`native Git evidence exceeded ${MAX_NATIVE_EVIDENCE_BYTES} retained bytes`);
            return;
          }
          stdout.push(chunk);
        };
        const onStderr = (chunk: Buffer) => {
          retainStderr(stderr, chunk, stderrSeenBytes);
          stderrSeenBytes += chunk.length;
        };
        const onError = (error: Error) => terminate(error.message);
        const onClose = (code: number | null) => {
          if (terminationMessage) {
            finish(failed(terminationMessage));
            return;
          }
          finish({
            code,
            stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
            stderr: decodeStderr(stderr, stderrSeenBytes)
          });
        };
        const timer = setTimeout(() => {
          terminate(`native Git command timed out after ${config.timeoutMs}ms`);
        }, config.timeoutMs);
        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.on('error', onError);
        child.on('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    } finally {
      release();
    }
  };
}

function createStreamingPatchRunner(config: NativeRunnerConfig): GitPatchRunner {
  return async (cwd, args, signal) => {
    const release = await SHARED_GIT_PROCESS_EXECUTOR.acquire(signal);
    if (!release) return failedPatch(abortReason(signal, config.timeoutMs));
    try {
      return await new Promise<GitPatchCapture>((resolve) => {
        if (signal?.aborted) {
          resolve(failedPatch(abortReason(signal, config.timeoutMs)));
          return;
        }
        const child = config.spawnImpl(config.gitBinary, args, {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
        const digest = createHash('sha256');
        const preview: Buffer[] = [];
        const stderr: Buffer[] = [];
        let previewBytes = 0;
        let fullByteLength = 0;
        let stderrSeenBytes = 0;
        let settled = false;
        let terminationMessage: string | null = null;
        let killGrace: NodeJS.Timeout | null = null;
        const cleanup = () => {
          clearTimeout(timer);
          if (killGrace) clearTimeout(killGrace);
          signal?.removeEventListener('abort', onAbort);
          child.stdout?.removeListener('data', onStdout);
          child.stderr?.removeListener('data', onStderr);
          child.removeListener('error', onError);
          child.removeListener('close', onClose);
          child.stdout?.destroy();
          child.stderr?.destroy();
        };
        const finish = (capture: GitPatchCapture) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(capture);
        };
        const terminate = (message: string) => {
          if (settled || terminationMessage) return;
          terminationMessage = message;
          clearTimeout(timer);
          child.stdout?.removeListener('data', onStdout);
          child.stderr?.removeListener('data', onStderr);
          try { child.kill(); } catch { /* best effort */ }
          if (!settled) {
            killGrace = setTimeout(() => finish(failedPatch(message)), PROCESS_KILL_GRACE_MS);
          }
        };
        const onAbort = () => terminate(abortReason(signal, config.timeoutMs));
        const onStdout = (chunk: Buffer) => {
          fullByteLength += chunk.length;
          digest.update(chunk);
          if (previewBytes >= WORKING_DIFF_PREVIEW_BYTES) return;
          const retained = chunk.subarray(
            0,
            Math.min(chunk.length, WORKING_DIFF_PREVIEW_BYTES - previewBytes)
          );
          if (!config.budget.tryRetain(retained.length)) {
            terminate(`native Git evidence exceeded ${MAX_NATIVE_EVIDENCE_BYTES} retained bytes`);
            return;
          }
          preview.push(retained);
          previewBytes += retained.length;
        };
        const onStderr = (chunk: Buffer) => {
          retainStderr(stderr, chunk, stderrSeenBytes);
          stderrSeenBytes += chunk.length;
        };
        const onError = (error: Error) => terminate(error.message);
        const onClose = (code: number | null) => {
          if (terminationMessage) {
            finish(failedPatch(terminationMessage));
            return;
          }
          const stderrText = decodeStderr(stderr, stderrSeenBytes);
          if (code !== 0) {
            finish(failedPatch(stderrText || `git diff exited with code ${String(code)}`));
            return;
          }
          finish({
            result: {
              code,
              stdout: decodePreview(Buffer.concat(preview, previewBytes)),
              stderr: stderrText
            },
            fullHash: digest.digest('hex'),
            fullByteLength
          });
        };
        const timer = setTimeout(() => {
          terminate(`native Git patch timed out after ${config.timeoutMs}ms`);
        }, config.timeoutMs);
        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.on('error', onError);
        child.on('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    } finally {
      release();
    }
  };
}

function emptyPatch(): GitPatchCapture {
  return {
    result: ok(),
    fullHash: sha256(Buffer.alloc(0)),
    fullByteLength: 0
  };
}

function failedPatch(message: string): GitPatchCapture {
  return { result: failed(message), fullHash: '', fullByteLength: 0 };
}

function retainStderr(target: Buffer[], chunk: Buffer, seenBytes: number): void {
  const payloadLimit = MAX_NATIVE_STDERR_BYTES - STDERR_TRUNCATED_MARKER.length;
  if (seenBytes >= payloadLimit) return;
  target.push(chunk.subarray(0, Math.min(chunk.length, payloadLimit - seenBytes)));
}

function decodeStderr(chunks: Buffer[], seenBytes: number): string {
  const retained = Buffer.concat(chunks);
  if (seenBytes <= retained.length) return retained.toString('utf8');
  return Buffer.concat([retained, STDERR_TRUNCATED_MARKER]).toString('utf8');
}

function abortReason(signal: AbortSignal | undefined, timeoutMs: number): string {
  return typeof signal?.reason === 'string'
    ? signal.reason
    : `native Git evidence timed out after ${timeoutMs}ms`;
}

function decodePreview(value: Buffer): string {
  return new StringDecoder('utf8').write(value);
}

export interface WslGitEvidenceAdapterOptions {
  spawnImpl?: typeof spawn;
  wslBinary?: string;
  timeoutMs?: number;
}

const DEFAULT_WSL_EVIDENCE_TIMEOUT_MS = 30_000;
export const WORKING_DIFF_PREVIEW_BYTES = 200_000;
const FRAME_PREFIX = 'SOLOE_GIT_EVIDENCE_V1';
const FRAME_END = 'SOLOE_GIT_EVIDENCE_END';
const MAX_WSL_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_WSL_STDERR_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const RESULT_KEYS = [
  'head', 'branch', 'baseLabel', 'baseOid', 'ahead', 'behind',
  'unpushed', 'status', 'diff', 'diffDigest', 'diffByteLength', 'recent'
] as const;

/** Executes the complete fixed Git plan through one wsl.exe process. */
export class WslGitEvidenceAdapter implements GitEvidenceAdapter {
  private readonly spawnImpl: typeof spawn;
  private readonly wslBinary: string;
  private readonly timeoutMs: number;

  constructor(private readonly distro: string, options: WslGitEvidenceAdapterOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.wslBinary = options.wslBinary ?? 'wsl.exe';
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_WSL_EVIDENCE_TIMEOUT_MS);
  }

  async collect(cwd: string, requestedBase?: string): Promise<RawGitEvidence> {
    const release = await SHARED_GIT_PROCESS_EXECUTOR.acquire();
    if (!release) return failedEvidence('WSL Git process admission aborted');
    try {
      return await this.collectAdmitted(cwd, requestedBase);
    } finally {
      release();
    }
  }

  private collectAdmitted(cwd: string, requestedBase?: string): Promise<RawGitEvidence> {
    return new Promise((resolve) => {
      const child = this.spawnImpl(
        this.wslBinary,
        [
          '-d', this.distro,
          '--', 'bash', '-s', '--',
          encodeArgument(cwd),
          encodeArgument(requestedBase?.trim() ?? '')
        ],
        { env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (evidence: RawGitEvidence) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(evidence);
      };
      const abort = (message: string) => {
        if (settled) return;
        finish(failedEvidence(message));
        child.removeAllListeners();
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.stdin?.removeAllListeners();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        try { child.kill(); } catch { /* best effort */ }
      };
      const timer = setTimeout(() => {
        abort(`WSL Git evidence timed out after ${this.timeoutMs}ms`);
      }, this.timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_WSL_EVIDENCE_BYTES) {
          abort(`WSL Git evidence exceeded ${MAX_WSL_EVIDENCE_BYTES} bytes`);
          return;
        }
        stdout.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= MAX_WSL_STDERR_BYTES) return;
        const remaining = MAX_WSL_STDERR_BYTES - stderrBytes;
        const retained = chunk.subarray(0, remaining);
        stderr.push(retained);
        stderrBytes += retained.length;
      });
      child.on('error', (error) => abort(error.message));
      child.on('close', (code) => {
        if (settled) return;
        const stderrText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          finish(failedEvidence(stderrText || `wsl.exe exited with code ${String(code)}`));
          return;
        }
        const parsed = parseWslEvidenceFrames(Buffer.concat(stdout, stdoutBytes));
        finish(parsed.ok
          ? materializeWslEvidence(parsed.frames, requestedBase)
          : failedEvidence(parsed.error));
      });
      child.stdin?.on('error', () => { /* child failure is handled above */ });
      child.stdin?.end(WSL_EVIDENCE_SCRIPT, 'utf8');
    });
  }
}

function materializeWslEvidence(
  frames: Map<string, GitCommandResult>,
  requestedBase?: string
): RawGitEvidence {
  const result = (key: typeof RESULT_KEYS[number]) =>
    frames.get(key) ?? failed(`WSL evidence omitted ${key}`);
  const baseLabelResult = result('baseLabel');
  const baseOidResult = result('baseOid');
  const label = successfulText(baseLabelResult);
  const oid = successfulOid(baseOidResult);
  const explicit = requestedBase?.trim();
  const baseError = explicit && (!label || !oid)
    ? `resolve requested base ${explicit}: ${describeFailure(baseOidResult)}`
    : undefined;
  const diffDigestResult = result('diffDigest');
  const diffLengthResult = result('diffByteLength');
  const diffFullHash = successfulText(diffDigestResult);
  const diffFullByteLength = Number.parseInt(successfulText(diffLengthResult), 10);
  const diffCapture = result('diff');
  const validDiffMetadata = diffCapture.code === 0 && /^[0-9a-f]{64}$/iu.test(diffFullHash) &&
    Number.isSafeInteger(diffFullByteLength) && diffFullByteLength >= 0;
  return {
    head: result('head'),
    branch: result('branch'),
    base: label && oid ? { label, oid } : null,
    ...(baseError ? { baseError } : {}),
    ahead: result('ahead'),
    behind: result('behind'),
    unpushed: result('unpushed'),
    status: result('status'),
    diff: validDiffMetadata
      ? diffCapture
      : failed('WSL evidence contains invalid working diff metadata'),
    diffFullHash: validDiffMetadata ? diffFullHash : '',
    diffFullByteLength: validDiffMetadata ? diffFullByteLength : 0,
    recent: result('recent')
  };
}

export type WslFrameParseResult =
  | { ok: true; frames: Map<string, GitCommandResult> }
  | { ok: false; error: string };

export function parseWslEvidenceFrames(output: Buffer | string): WslFrameParseResult {
  const bytes = typeof output === 'string' ? Buffer.from(output) : output;
  const results = new Map<string, GitCommandResult>();
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0 || newline - offset > 512) {
      return { ok: false, error: 'WSL evidence has a truncated or oversized frame header' };
    }
    const header = bytes.subarray(offset, newline).toString('utf8').replace(/\r$/u, '');
    offset = newline + 1;
    if (header.startsWith(`${FRAME_END}\t`)) {
      const count = Number(header.slice(FRAME_END.length + 1));
      if (count !== RESULT_KEYS.length || results.size !== RESULT_KEYS.length) {
        return { ok: false, error: 'WSL evidence end marker has the wrong frame count' };
      }
      if (offset !== bytes.length) {
        return { ok: false, error: 'WSL evidence contains trailing bytes after its end marker' };
      }
      return { ok: true, frames: results };
    }
    const fields = header.split('\t');
    if (fields.length !== 5 || fields[0] !== FRAME_PREFIX) {
      return { ok: false, error: 'WSL evidence has an invalid frame header' };
    }
    const [, key, codeText, stdoutLengthText, stderrLengthText] = fields;
    if (!key || !RESULT_KEYS.includes(key as typeof RESULT_KEYS[number])) {
      return { ok: false, error: `WSL evidence contains unknown frame ${key ?? ''}` };
    }
    if (results.has(key)) {
      return { ok: false, error: `WSL evidence contains duplicate frame ${key}` };
    }
    const code = Number(codeText);
    const stdoutLength = Number(stdoutLengthText);
    const stderrLength = Number(stderrLengthText);
    if (!Number.isInteger(code) || !validLength(stdoutLength) || !validLength(stderrLength)) {
      return { ok: false, error: `WSL evidence frame ${key} has invalid metadata` };
    }
    if (stdoutLength + stderrLength > MAX_FRAME_BYTES) {
      return { ok: false, error: `WSL evidence frame ${key} exceeds its size limit` };
    }
    const frameEnd = offset + stdoutLength + stderrLength;
    if (frameEnd > bytes.length) {
      return { ok: false, error: `WSL evidence frame ${key} is truncated` };
    }
    const stdoutBytes = bytes.subarray(offset, offset + stdoutLength);
    results.set(key, {
      code,
      stdout: key === 'diff' ? decodePreview(stdoutBytes) : stdoutBytes.toString('utf8'),
      stderr: bytes.subarray(offset + stdoutLength, frameEnd).toString('utf8')
    });
    offset = frameEnd;
  }
  return { ok: false, error: 'WSL evidence is missing its end marker' };
}

function failedEvidence(message: string): RawGitEvidence {
  const failure = failed(message);
  return {
    head: failure,
    branch: failure,
    base: null,
    ahead: failure,
    behind: failure,
    unpushed: failure,
    status: failure,
    diff: failure,
    diffFullHash: '',
    diffFullByteLength: 0,
    recent: failure
  };
}

function successfulText(result: GitCommandResult): string {
  return result.code === 0 ? result.stdout.trim() : '';
}

function successfulOid(result: GitCommandResult): string {
  const value = successfulText(result);
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value) ? value : '';
}

function describeFailure(result: GitCommandResult): string {
  return result.stderr.trim().split('\n')[0] || `git exited with code ${String(result.code)}`;
}

function ok(stdout = ''): GitCommandResult {
  return { code: 0, stdout, stderr: '' };
}

function failed(stderr: string): GitCommandResult {
  return { code: null, stdout: '', stderr };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = Math.trunc(value ?? fallback);
  return resolved > 0 ? resolved : fallback;
}

function validLength(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function encodeArgument(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

// The body is sent over stdin because wsl.exe expands `$...` in command-line
// arguments before bash sees them. The requested ref remains positional argv
// data, while only resolved OIDs are used by later generated commands.
const WSL_EVIDENCE_SCRIPT = String.raw`set +e
tmp_dir=$(mktemp -d 2>/dev/null)
if [ -z "$tmp_dir" ]; then
  exit 70
fi
trap 'rm -rf "$tmp_dir"' EXIT

run_result() {
  key=$1
  shift
  "$@" >"$tmp_dir/$key.out" 2>"$tmp_dir/$key.err"
  printf %s "$?" >"$tmp_dir/$key.code"
}

write_result() {
  key=$1
  value=$2
  printf %s "$value" >"$tmp_dir/$key.out"
  : >"$tmp_dir/$key.err"
  printf 0 >"$tmp_dir/$key.code"
}

empty_result() {
  write_result "$1" ''
}

valid_oid() {
  value=$1
  case "$value" in
    ''|*[!0-9a-fA-F]*) return 1 ;;
  esac
  [ "\${#value}" -eq 40 ] || [ "\${#value}" -eq 64 ]
}

probe_base() {
  ref=$1
  git rev-parse --verify --end-of-options "\${ref}^{commit}" >"$tmp_dir/base-probe.out" 2>"$tmp_dir/base-probe.err"
  code=$?
  candidate_oid=$(tr -d '\r\n' <"$tmp_dir/base-probe.out")
  if [ "$code" -eq 0 ] && valid_oid "$candidate_oid"; then
    base_label=$ref
    base_oid=$candidate_oid
    return 0
  fi
  return 1
}

finish_diff_capture() {
  head -c 200000 "$tmp_dir/diff.full" >"$tmp_dir/diff.out"
  digest_line=$(sha256sum "$tmp_dir/diff.full" 2>/dev/null)
  set -- $digest_line
  write_result diffDigest "$1"
  byte_length=$(wc -c <"$tmp_dir/diff.full")
  write_result diffByteLength "$byte_length"
}

emit_frame() {
  key=$1
  code=$(cat "$tmp_dir/$key.code" 2>/dev/null)
  stdout_bytes=$(wc -c <"$tmp_dir/$key.out" 2>/dev/null)
  stderr_bytes=$(wc -c <"$tmp_dir/$key.err" 2>/dev/null)
  printf 'SOLOE_GIT_EVIDENCE_V1\t%s\t%s\t%s\t%s\n' \
    "$key" "\${code:-70}" "\${stdout_bytes:-0}" "\${stderr_bytes:-0}"
  cat "$tmp_dir/$key.out" "$tmp_dir/$key.err"
}

worktree_cwd=$(printf %s "$1" | base64 -d 2>/dev/null)
requested_base=$(printf %s "$2" | base64 -d 2>/dev/null)
if ! cd -- "$worktree_cwd"; then
  exit 72
fi
run_result head git rev-parse --verify 'HEAD^{commit}'
run_result branch git rev-parse --abbrev-ref HEAD
head_oid=$(tr -d '\r\n' <"$tmp_dir/head.out")
branch_name=$(tr -d '\r\n' <"$tmp_dir/branch.out")
if ! valid_oid "$head_oid"; then
  head_oid=''
  if [ "$(cat "$tmp_dir/head.code")" -eq 0 ]; then
    printf 65 >"$tmp_dir/head.code"
    printf %s 'git returned an invalid HEAD OID' >"$tmp_dir/head.err"
  fi
fi
base_label=''
base_oid=''

if [ -n "$requested_base" ]; then
  base_label=$requested_base
  git rev-parse --verify --end-of-options "\${requested_base}^{commit}" >"$tmp_dir/baseOid.out" 2>"$tmp_dir/baseOid.err"
  printf %s "$?" >"$tmp_dir/baseOid.code"
  if [ "$(cat "$tmp_dir/baseOid.code")" -eq 0 ]; then
    base_oid=$(tr -d '\r\n' <"$tmp_dir/baseOid.out")
    if ! valid_oid "$base_oid"; then
      base_oid=''
      printf 65 >"$tmp_dir/baseOid.code"
      printf %s 'git returned an invalid base OID' >"$tmp_dir/baseOid.err"
    fi
  fi
else
  upstream=$(git rev-parse --abbrev-ref "\${branch_name:-HEAD}@{upstream}" 2>/dev/null)
  if [ -n "$upstream" ]; then
    probe_base "$upstream"
  fi
  if [ -z "$base_oid" ]; then
    for candidate in origin/main origin/master main master; do
      if probe_base "$candidate"; then
        break
      fi
    done
  fi
  write_result baseOid "$base_oid"
fi
write_result baseLabel "$base_label"

if [ -n "$head_oid" ] && [ -n "$base_oid" ]; then
  run_result ahead git rev-list "\${base_oid}..\${head_oid}"
  run_result behind git rev-list --count "\${head_oid}..\${base_oid}"
else
  empty_result ahead
  empty_result behind
fi
if [ -n "$head_oid" ]; then
  run_result unpushed git rev-list --max-count=30 "$head_oid" --not --remotes
  git diff "$head_oid" --no-color --no-ext-diff --no-textconv \
    >"$tmp_dir/diff.full" 2>"$tmp_dir/diff.err"
  printf %s "$?" >"$tmp_dir/diff.code"
  finish_diff_capture
  run_result recent git log -30 "$head_oid" '--pretty=format:%H%x1f%h%x1f%s%x1f%aI'
else
  empty_result unpushed
  : >"$tmp_dir/diff.full"
  empty_result diff
  finish_diff_capture
  empty_result recent
fi
run_result status git status --porcelain=v2 --branch --untracked-files=all -z

for key in head branch baseLabel baseOid ahead behind unpushed status diff diffDigest diffByteLength recent; do
  emit_frame "$key"
done
printf 'SOLOE_GIT_EVIDENCE_END\t12\n'
`.replaceAll('\\${', '${');
