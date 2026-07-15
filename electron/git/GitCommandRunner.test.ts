import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as spawnProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { GitProcessExecutor } from './GitProcessExecutor.js';
import { runGitCommand } from './GitCommandRunner.js';

describe('runGitCommand', () => {
  it('waits for stdio close instead of losing output that arrives after exit', async () => {
    const child = fakeChild();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawnProcess;
    const result = runGitCommand('git', ['diff'], {
      spawnImpl: spawnMock,
      executor: new GitProcessExecutor(1),
      timeoutMs: 1_000
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

    child.emit('exit', 0);
    child.stdout.write('1\t0\ta.txt\0');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);

    await expect(result).resolves.toEqual({
      code: 0,
      stdout: '1\t0\ta.txt\0',
      stderr: ''
    });
  });

  it('bounds stderr while retaining the command exit code', async () => {
    const child = fakeChild();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawnProcess;
    const result = runGitCommand('git', ['status'], {
      spawnImpl: spawnMock,
      executor: new GitProcessExecutor(1),
      timeoutMs: 1_000,
      stderrLimitBytes: 4
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

    child.stderr.write('abcdefgh');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 128);

    await expect(result).resolves.toEqual({
      code: 128,
      stdout: '',
      stderr: 'abcd\n…[output truncated]'
    });
  });

  it('force-settles a kill-resistant child and releases the queued permit', async () => {
    vi.useFakeTimers();
    try {
      const firstChild = fakeChild();
      const secondChild = fakeChild();
      const spawnMock = vi.fn()
        .mockReturnValueOnce(firstChild)
        .mockReturnValueOnce(secondChild) as unknown as typeof spawnProcess;
      const executor = new GitProcessExecutor(1);

      const first = runGitCommand('git', ['status'], {
        spawnImpl: spawnMock,
        executor,
        timeoutMs: 10
      });
      await Promise.resolve();
      const second = runGitCommand('git', ['diff'], {
        spawnImpl: spawnMock,
        executor,
        timeoutMs: 1_000
      });
      await Promise.resolve();
      expect(spawnMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(firstChild.kill).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(50);

      await expect(first).resolves.toEqual({
        code: null,
        stdout: '',
        stderr: 'Git command timed out after 10ms'
      });
      expect(spawnMock).toHaveBeenCalledTimes(2);

      secondChild.stdout.end('ready');
      secondChild.stderr.end();
      secondChild.emit('close', 0);
      await expect(second).resolves.toEqual({ code: 0, stdout: 'ready', stderr: '' });

      // A close published after forced settlement cannot settle twice or
      // interfere with the command admitted behind it.
      firstChild.emit('close', 0);
      expect(firstChild.stdout.destroyed).toBe(true);
      expect(firstChild.stderr.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-settles output overflow without zero-padding rejected bytes', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const spawnMock = vi.fn(() => child) as unknown as typeof spawnProcess;
      const result = runGitCommand('git', ['diff'], {
        spawnImpl: spawnMock,
        executor: new GitProcessExecutor(1),
        timeoutMs: 1_000,
        stdoutLimitBytes: 4
      });
      await Promise.resolve();

      child.stdout.write('ok');
      child.stdout.write('rejected');
      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toEqual({
        code: null,
        stdout: 'ok',
        stderr: 'Git command output exceeded 4 bytes'
      });
      expect(Buffer.from((await result).stdout)).toEqual(Buffer.from('ok'));
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
}
