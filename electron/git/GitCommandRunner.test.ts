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
