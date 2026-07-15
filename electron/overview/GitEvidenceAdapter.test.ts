import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  NativeGitEvidenceAdapter,
  WslGitEvidenceAdapter,
  parseWslEvidenceFrames,
  type GitCommandRunner,
  type GitPatchRunner
} from './GitEvidenceAdapter.js';
import { WorktreeFactsCollector } from './WorktreeFactsCollector.js';

const HEAD = '1'.repeat(40);
const BASE = 'b'.repeat(40);
const execFileAsync = promisify(execFile);

describe('NativeGitEvidenceAdapter resource contract', () => {
  it('uses streaming patch capture instead of buffering diff through the command runner', async () => {
    const runGit = nativeFixtureRunner();
    const runPatch = vi.fn(async () => ({
      result: ok('preview only'),
      fullHash: 'a'.repeat(64),
      fullByteLength: 20_000_000
    })) as GitPatchRunner;
    const adapter = new NativeGitEvidenceAdapter({ runGit, runPatch });

    const raw = await adapter.collect('/repo', 'main');

    expect(runPatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runGit).mock.calls.some(([, args]) => args[0] === 'diff')).toBe(false);
    expect(raw).toMatchObject({
      diff: { code: 0, stdout: 'preview only' },
      diffFullHash: 'a'.repeat(64),
      diffFullByteLength: 20_000_000
    });
  });

  it('streams a large patch with byte-accurate digest, bounded preview, and two-child peak', async () => {
    const patch = Buffer.concat([
      Buffer.alloc(199_999, 0x78),
      Buffer.from('€', 'utf8'),
      Buffer.from([0xff, 0xfe, 0x00, 0x0a]),
      Buffer.alloc(1_800_000, 0x79)
    ]);
    let active = 0;
    let peak = 0;
    const spawnMock = vi.fn((
      _file: string,
      args: readonly string[]
    ) => {
      const child = new FakeChild();
      active += 1;
      peak = Math.max(peak, active);
      child.once('close', () => { active -= 1; });
      queueMicrotask(() => child.succeed(nativeOutput(args, patch)));
      return child;
    });
    const adapter = new NativeGitEvidenceAdapter({
      spawnImpl: spawnMock as unknown as typeof spawnProcess,
      timeoutMs: 1_000
    });

    const raw = await adapter.collect('/repo', 'main');

    expect(raw.diff).toMatchObject({ code: 0 });
    expect(Buffer.byteLength(raw.diff.stdout)).toBe(199_999);
    expect(raw.diff.stdout).not.toContain('�');
    expect(raw.diffFullByteLength).toBe(patch.length);
    expect(raw.diffFullHash).toBe(createHash('sha256').update(patch).digest('hex'));
    expect(peak).toBeLessThanOrEqual(2);
    expect(spawnMock.mock.calls.filter(([, args]) => args[0] === 'diff')).toHaveLength(1);
  });

  it('degrades and kills an ordinary Git command that exceeds its output ceiling', async () => {
    const children: FakeChild[] = [];
    const spawnMock = vi.fn((
      _file: string,
      args: readonly string[]
    ) => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => {
        child.succeed(args[0] === 'status'
          ? Buffer.alloc(1_025, 0x78)
          : nativeOutput(args, Buffer.alloc(0)));
      });
      return child;
    });
    const adapter = new NativeGitEvidenceAdapter({
      spawnImpl: spawnMock as unknown as typeof spawnProcess,
      maxCommandBytes: 1_024,
      timeoutMs: 1_000
    });

    const raw = await adapter.collect('/repo', 'main');

    expect(raw.status).toMatchObject({ code: null, stdout: '' });
    expect(raw.status.stderr).toContain('output exceeded 1024 bytes');
    expect(children.some((child) => child.killed)).toBe(true);
  });

  it('applies one generation deadline and kills every live native Git child', async () => {
    const children: FakeChild[] = [];
    const spawnMock = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const adapter = new NativeGitEvidenceAdapter({
      spawnImpl: spawnMock as unknown as typeof spawnProcess,
      timeoutMs: 5
    });

    const startedAt = Date.now();
    const raw = await adapter.collect('/repo', 'main');

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(children.every((child) => child.killed)).toBe(true);
    expect(raw.head).toMatchObject({ code: null });
    expect(raw.head.stderr).toContain('native Git evidence timed out');
  });

  it('does not publish digest metadata for a failed partial patch', async () => {
    const spawnMock = vi.fn((
      _file: string,
      args: readonly string[]
    ) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        if (args[0] === 'diff') {
          child.succeed('partial patch', 'diff failed', 1);
        } else {
          child.succeed(nativeOutput(args, Buffer.alloc(0)));
        }
      });
      return child;
    });
    const adapter = new NativeGitEvidenceAdapter({
      spawnImpl: spawnMock as unknown as typeof spawnProcess
    });

    const raw = await adapter.collect('/repo', 'main');

    expect(raw.diff).toMatchObject({ code: null, stdout: '', stderr: 'diff failed' });
    expect(raw.diffFullHash).toBe('');
    expect(raw.diffFullByteLength).toBe(0);
  });

  it('marks bounded stderr as truncated', async () => {
    const spawnMock = vi.fn((
      _file: string,
      args: readonly string[]
    ) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        if (args[0] === 'status') {
          child.succeed('', Buffer.alloc(70_000, 0x65), 1);
        } else {
          child.succeed(nativeOutput(args, Buffer.alloc(0)));
        }
      });
      return child;
    });
    const adapter = new NativeGitEvidenceAdapter({
      spawnImpl: spawnMock as unknown as typeof spawnProcess
    });

    const raw = await adapter.collect('/repo', 'main');

    expect(Buffer.byteLength(raw.status.stderr)).toBeLessThanOrEqual(64 * 1024);
    expect(raw.status.stderr).toContain('[stderr truncated]');
  });

  it('shares the two-process ceiling across concurrent worktree generations', async () => {
    let active = 0;
    let peak = 0;
    const spawnMock = vi.fn((
      _file: string,
      args: readonly string[]
    ) => {
      const child = new FakeChild();
      active += 1;
      peak = Math.max(peak, active);
      child.once('close', () => { active -= 1; });
      setTimeout(() => child.succeed(nativeOutput(args, Buffer.alloc(0))), 1);
      return child;
    });
    const options = {
      spawnImpl: spawnMock as unknown as typeof spawnProcess,
      timeoutMs: 1_000
    };

    await Promise.all([
      new NativeGitEvidenceAdapter(options).collect('/repo-one', 'main'),
      new NativeGitEvidenceAdapter(options).collect('/repo-two', 'main')
    ]);

    expect(peak).toBe(2);
  });

  it('enforces one retained-output budget across the whole native generation', async () => {
    const large = Buffer.alloc(4_500_000, 0x31);
    const spawnMock = vi.fn((
      _file: string,
      args: readonly string[]
    ) => {
      const child = new FakeChild();
      queueMicrotask(() => {
        const graphOutput = args[0] === 'rev-list' &&
          (args[1] === `${BASE}..${HEAD}` || args[1] === '--count');
        child.succeed(graphOutput ? large : nativeOutput(args, Buffer.alloc(0)));
      });
      return child;
    });
    const adapter = new NativeGitEvidenceAdapter({
      spawnImpl: spawnMock as unknown as typeof spawnProcess
    });

    const raw = await adapter.collect('/repo', 'main');

    expect([raw.ahead, raw.behind].filter((result) => result.code === null)).toHaveLength(1);
    expect(`${raw.ahead.stderr}${raw.behind.stderr}`).toContain(
      'native Git evidence exceeded 8388608 retained bytes'
    );
  });
});

describe('WslGitEvidenceAdapter', () => {
  it('materializes one binary-safe evidence generation through one wsl.exe launch', async () => {
    const child = new FakeChild();
    const spawnMock = vi.fn((..._args: Parameters<typeof spawnProcess>) => child);
    const requestedBase = `release/$USER'; touch /tmp/not-allowed; #`;
    const collector = new WorktreeFactsCollector({
      spawnImpl: spawnMock as unknown as typeof spawnProcess
    });
    const pending = collector.collect('/repo with spaces', requestedBase, {
      runMode: 'wsl',
      wslDistro: 'Ubuntu Test'
    });
    await waitFor(() => spawnMock.mock.calls.length === 1 && child.stdinText.length > 0);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe('wsl.exe');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '-d', 'Ubuntu Test', '--', 'bash', '-s', '--',
      Buffer.from('/repo with spaces').toString('base64'),
      Buffer.from(requestedBase).toString('base64')
    ]);
    // The ref remains argv data; it is never interpolated into shell code.
    expect(child.stdinText).not.toContain(requestedBase);

    const diff = 'diff --git a/file b/file\n-old\tvalue\n+new\0value\n';
    child.succeed(frames({
      head: ok(HEAD),
      branch: ok('feature/tab-safe\n'),
      baseLabel: ok(requestedBase),
      baseOid: ok(BASE),
      ahead: ok(`${HEAD}\n`),
      behind: ok('0\n'),
      unpushed: ok(`${HEAD}\n`),
      status: ok('? odd\tname.txt\0'),
      diff: ok(diff),
      diffDigest: ok('d'.repeat(64)),
      diffByteLength: ok(String(Buffer.byteLength(diff))),
      recent: ok(`${HEAD}\x1f1111111\x1fsubject with\ttab\x1f2026-07-14T00:00:00Z`)
    }));

    const facts = await pending;
    expect(facts).toMatchObject({
      completeness: 'complete',
      head: HEAD,
      baseBranch: requestedBase,
      baseOid: BASE,
      commitsAhead: 1,
      pushedAhead: false,
      dirtyFiles: [{ path: 'odd\tname.txt', status: 'untracked', kind: '?' }]
    });
    expect(facts.workingDiff).toContain('+new\0value');
    expect(facts.recentCommits[0]?.subject).toBe('subject with\ttab');
  });

  it('degrades missing or malformed frames instead of fabricating clean evidence', async () => {
    const child = new FakeChild();
    const spawnMock = vi.fn(() => child);
    const adapter = new WslGitEvidenceAdapter('Ubuntu', {
      spawnImpl: spawnMock as unknown as typeof spawnProcess
    });
    const pending = adapter.collect('/repo');
    await waitFor(() => spawnMock.mock.calls.length === 1);
    child.succeed(`${frame('head', ok(HEAD))}malformed\n`);

    const raw = await pending;
    expect(raw.head).toMatchObject({ code: null });
    expect(raw.status).toMatchObject({ code: null });
    expect(raw.status.stderr).toContain('invalid frame header');
  });

  it('decodes arbitrary framed bytes without delimiter collisions', () => {
    const payload = 'line one\nline\ttwo\0line three\r\n';
    const parsed = parseWslEvidenceFrames(frames({ diff: ok(payload) }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.frames.get('diff')?.stdout).toBe(payload);
  });

  it.each([
    ['unknown frame', 'SOLOE_GIT_EVIDENCE_V1\tother\t0\t0\t0\n'],
    ['truncated payload', 'SOLOE_GIT_EVIDENCE_V1\thead\t0\t40\t0\nshort'],
    ['duplicate frame', `${frame('head', ok(HEAD))}${frame('head', ok(HEAD))}`],
    ['missing end marker', frame('head', ok(HEAD))]
  ])('rejects %s', (_name, bytes) => {
    expect(parseWslEvidenceFrames(bytes)).toMatchObject({ ok: false });
  });

  it('kills a timed-out batch and releases its streams and listeners', async () => {
    const child = new FakeChild();
    const adapter = new WslGitEvidenceAdapter('Ubuntu', {
      spawnImpl: vi.fn(() => child) as unknown as typeof spawnProcess,
      timeoutMs: 5
    });

    const raw = await adapter.collect('/repo');

    expect(raw.head.stderr).toContain('timed out');
    expect(child.killed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('runs the stdin plan against a real repository with native-equivalent facts', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-wsl-evidence-'));
    try {
      await git(repo, ['init', '-b', 'main']);
      await git(repo, ['config', 'user.email', 'test@soloe.local']);
      await git(repo, ['config', 'user.name', 'Soloe Test']);
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\n', 'utf8');
      await git(repo, ['add', 'tracked.txt']);
      await git(repo, ['commit', '-m', 'base']);
      await git(repo, ['switch', '-c', 'feature']);
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'x'.repeat(250_001), 'utf8');
      await fs.writeFile(path.join(repo, 'new file.txt'), 'untracked\n', 'utf8');

      const spawnMock = vi.fn((
        _file: string,
        args: readonly string[]
      ) => spawnProcess(
        'bash',
        [
          '-s', '--',
          String(args.at(-2) ?? ''),
          String(args.at(-1) ?? '')
        ],
        { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] }
      ));
      const wslCollector = new WorktreeFactsCollector({
        spawnImpl: spawnMock as unknown as typeof spawnProcess
      });
      const nativeCollector = new WorktreeFactsCollector();

      const [wslFacts, nativeFacts] = await Promise.all([
        wslCollector.collect(repo, 'main', { runMode: 'wsl', wslDistro: 'Test' }),
        nativeCollector.collect(repo, 'main', { runMode: 'windows' })
      ]);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(wslFacts.completeness).toBe('complete');
      expect(wslFacts).toMatchObject({
        head: nativeFacts.head,
        baseOid: nativeFacts.baseOid,
        commitsAhead: nativeFacts.commitsAhead,
        commitsBehind: nativeFacts.commitsBehind,
        dirtyFiles: nativeFacts.dirtyFiles,
        dirtyHash: nativeFacts.dirtyHash,
        workingDiff: nativeFacts.workingDiff,
        recentCommits: nativeFacts.recentCommits
      });
      expect(wslFacts.workingDiff).toContain('[truncated, full diff was');
      expect(Buffer.byteLength(wslFacts.workingDiff)).toBeLessThan(201_000);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

type FrameKey =
  | 'head' | 'branch' | 'baseLabel' | 'baseOid' | 'ahead'
  | 'behind' | 'unpushed' | 'status' | 'diff' | 'diffDigest'
  | 'diffByteLength' | 'recent';

function frames(results: Partial<Record<FrameKey, Result>>): string {
  const complete: Record<FrameKey, Result> = {
    head: ok(HEAD),
    branch: ok('feature'),
    baseLabel: ok('main'),
    baseOid: ok(BASE),
    ahead: ok(''),
    behind: ok('0'),
    unpushed: ok(''),
    status: ok(''),
    diff: ok(''),
    diffDigest: ok('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
    diffByteLength: ok('0'),
    recent: ok(''),
    ...results
  };
  return Object.entries(complete)
    .map(([key, result]) => frame(key as FrameKey, result))
    .join('') + 'SOLOE_GIT_EVIDENCE_END\t12\n';
}

function frame(key: FrameKey, result: Result): string {
  return [
    'SOLOE_GIT_EVIDENCE_V1', key, String(result.code),
    String(Buffer.byteLength(result.stdout)),
    String(Buffer.byteLength(result.stderr))
  ].join('\t') + `\n${result.stdout}${result.stderr}`;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function ok(stdout: string): Result {
  return { code: 0, stdout, stderr: '' };
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  stdinText = '';
  killed = false;

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => { this.stdinText += chunk; });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  succeed(output: string | Buffer, stderr: string | Buffer = '', code = 0): void {
    this.stdout.end(output);
    this.stderr.end(stderr);
    this.emit('close', code);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for predicate');
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

function nativeFixtureRunner(): GitCommandRunner {
  return vi.fn(async (_cwd: string, args: string[]) => {
    if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD^{commit}') return ok(HEAD);
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('feature');
    if (args[0] === 'rev-parse' && args.at(-1) === 'main^{commit}') return ok(BASE);
    if (args[0] === 'rev-list' && args[1] === `${BASE}..${HEAD}`) return ok(HEAD);
    if (args[0] === 'rev-list' && args[1] === '--count') return ok('0');
    if (args[0] === 'rev-list' && args.includes('--remotes')) return ok('');
    if (args[0] === 'status') return ok('');
    if (args[0] === 'log') return ok('');
    throw new Error(`unexpected Git command: ${args.join(' ')}`);
  }) as GitCommandRunner;
}

function nativeOutput(args: readonly string[], patch: Buffer): string | Buffer {
  if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD^{commit}') return HEAD;
  if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feature';
  if (args[0] === 'rev-parse' && args.at(-1) === 'main^{commit}') return BASE;
  if (args[0] === 'rev-list' && args[1] === `${BASE}..${HEAD}`) return HEAD;
  if (args[0] === 'rev-list' && args[1] === '--count') return '0';
  if (args[0] === 'rev-list' && args.includes('--remotes')) return '';
  if (args[0] === 'status') return '';
  if (args[0] === 'diff') return patch;
  if (args[0] === 'log') return '';
  throw new Error(`unexpected native Git command: ${args.join(' ')}`);
}
