import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FileSearchService } from './FileSearchService.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('FileSearchService', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-files-')));
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'src', 'App.svelte'), '<script></script>\n', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'README.md'), '# readme\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('search: returns fuzzy-ranked files from a directory', async () => {
    const service = new FileSearchService({ getBinaries: () => ({ git: '/missing', fd: '/missing', rg: '/missing' }) });

    const results = await service.search(tmpRoot, 'app', 10);
    expect(results[0]).toEqual({
      rootPath: tmpRoot,
      path: path.join('src', 'App.svelte').replace(/\\/g, '/'),
      absolutePath: path.join(tmpRoot, 'src', 'App.svelte')
    });
  });

  it.skipIf(!hasGit)('search: uses git ls-files including untracked non-ignored files', async () => {
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: tmpRoot });
    await fs.writeFile(path.join(tmpRoot, '.gitignore'), 'ignored.txt\n', 'utf8');
    await fs.writeFile(path.join(tmpRoot, 'ignored.txt'), 'ignored\n', 'utf8');
    spawnSync('git', ['add', 'README.md', '.gitignore'], { cwd: tmpRoot });

    const service = new FileSearchService();
    const results = await service.search(tmpRoot, 'read', 10);
    expect(results.map((r) => r.path)).toContain('README.md');
    expect(results.map((r) => r.path)).not.toContain('ignored.txt');
  });

  it('search: returns empty results for a missing root', async () => {
    const service = new FileSearchService();
    await expect(service.search(path.join(tmpRoot, 'missing'), 'x')).resolves.toEqual([]);
  });
});
