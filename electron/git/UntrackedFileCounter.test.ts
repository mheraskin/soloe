import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UntrackedFileCounter } from './UntrackedFileCounter.js';

describe('UntrackedFileCounter', () => {
  let root: string;
  let counter: UntrackedFileCounter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-untracked-'));
    counter = new UntrackedFileCounter(2);
  });

  afterEach(async () => {
    counter.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('counts text lines and detects binary files without whole-file allocation', async () => {
    await fs.writeFile(path.join(root, 'trailing.txt'), 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(root, 'unterminated.txt'), 'one\ntwo');
    await fs.writeFile(path.join(root, 'empty.txt'), '');
    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([1, 2, 0, 3, 10]));

    const result = await counter.measure(root, [
      'trailing.txt',
      'unterminated.txt',
      'empty.txt',
      'binary.bin'
    ]);

    expect(result.get('trailing.txt')).toEqual({ lines: 3, binary: false });
    expect(result.get('unterminated.txt')).toEqual({ lines: 2, binary: false });
    expect(result.get('empty.txt')).toEqual({ lines: 0, binary: false });
    expect(result.get('binary.bin')).toEqual({ lines: 0, binary: true });
  });

  it('invalidates cached measurements when file metadata changes', async () => {
    const file = path.join(root, 'changing.txt');
    await fs.writeFile(file, 'one\n');
    await expect(counter.measure(root, ['changing.txt'])).resolves.toEqual(
      new Map([['changing.txt', { lines: 1, binary: false }]])
    );

    await fs.writeFile(file, 'one\ntwo\n');
    const future = new Date(Date.now() + 2_000);
    await fs.utimes(file, future, future);

    await expect(counter.measure(root, ['changing.txt'])).resolves.toEqual(
      new Map([['changing.txt', { lines: 2, binary: false }]])
    );
  });

  it('omits inaccessible paths so callers can use their authoritative fallback', async () => {
    await expect(counter.measure(root, ['missing.txt'])).resolves.toEqual(new Map());
  });
});
