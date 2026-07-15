import { spawn, type SpawnOptions } from 'node:child_process';
import {
  GitProcessExecutor,
  SHARED_GIT_PROCESS_EXECUTOR
} from './GitProcessExecutor.js';

export interface GitCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitCommandOptions {
  cwd?: string;
  spawnImpl?: typeof spawn;
  executor?: GitProcessExecutor;
  timeoutMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const PROCESS_KILL_GRACE_MS = 50;
const OUTPUT_TRUNCATED = '\n…[output truncated]';

/**
 * Bounded physical-process Adapter used by ordinary Git commands.
 *
 * The Interface resolves only after `close`, when stdio is drained; `exit`
 * alone does not guarantee that the final stdout data has been delivered.
 */
export async function runGitCommand(
  binary: string,
  args: string[],
  options: GitCommandOptions = {}
): Promise<GitCommandResult> {
  const executor = options.executor ?? SHARED_GIT_PROCESS_EXECUTOR;
  const release = await executor.acquire();
  if (!release) return { code: null, stdout: '', stderr: 'Git process admission aborted' };
  try {
    return await runAdmittedGitCommand(binary, args, options);
  } finally {
    release();
  }
}

function runAdmittedGitCommand(
  binary: string,
  args: string[],
  options: GitCommandOptions
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const stdoutLimit = positiveInteger(
      options.stdoutLimitBytes,
      DEFAULT_STDOUT_LIMIT_BYTES
    );
    const stderrLimit = positiveInteger(
      options.stderrLimitBytes,
      DEFAULT_STDERR_LIMIT_BYTES
    );
    let settled = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSeen = 0;
    let stdoutRetained = 0;
    let stderrSeen = 0;
    let stderrRetained = 0;
    let terminationMessage = '';
    let timer: NodeJS.Timeout | null = null;
    let killGrace: NodeJS.Timeout | null = null;
    const spawnOptions: SpawnOptions = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    };
    const child = (options.spawnImpl ?? spawn)(binary, args, spawnOptions);
    const onStdout = (chunk: Buffer) => {
      stdoutSeen += chunk.length;
      if (stdoutSeen > stdoutLimit) {
        terminate(`Git command output exceeded ${stdoutLimit} bytes`);
        return;
      }
      stdout.push(chunk);
      stdoutRetained += chunk.length;
    };
    const onStderr = (chunk: Buffer) => {
      stderrSeen += chunk.length;
      if (stderrRetained >= stderrLimit) return;
      const retained = chunk.subarray(0, stderrLimit - stderrRetained);
      stderr.push(retained);
      stderrRetained += retained.length;
    };
    const decodeStdout = () => Buffer.concat(stdout, stdoutRetained).toString('utf8');
    const decodeStderr = () => Buffer.concat(stderr, stderrRetained).toString('utf8') +
      (stderrSeen > stderrRetained ? OUTPUT_TRUNCATED : '');
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (terminationMessage) child.once('error', () => { /* ignore late child failure */ });
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
      if (timer) clearTimeout(timer);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      try { child.kill(); } catch { /* best effort */ }
      if (settled) return;
      killGrace = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
        (child as typeof child & { unref?: () => void }).unref?.();
        finish({ code: null, stdout: decodeStdout(), stderr: message });
      }, PROCESS_KILL_GRACE_MS);
    };
    const onError = (error: Error) => {
      if (terminationMessage) {
        finish({ code: null, stdout: decodeStdout(), stderr: terminationMessage });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      const prefix = code ? `${code}: ` : '';
      finish({
        code: null,
        stdout: decodeStdout(),
        stderr: `${prefix}${error.message}`
      });
    };
    const onClose = (code: number | null) => {
      finish(terminationMessage
        ? { code: null, stdout: decodeStdout(), stderr: terminationMessage }
        : { code, stdout: decodeStdout(), stderr: decodeStderr() });
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);
    timer = setTimeout(() => {
      terminate(`Git command timed out after ${timeoutMs}ms`);
    }, timeoutMs);
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}
