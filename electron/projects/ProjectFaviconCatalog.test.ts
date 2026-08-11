import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Project } from '@shared/types/projects.js';
import { ProjectFaviconCatalog } from './ProjectFaviconCatalog.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-favicon-catalog-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('ProjectFaviconCatalog', () => {
  it('prioritizes likely roots within a global traversal budget', async () => {
    await fs.mkdir(path.join(root, 'public'));
    await fs.writeFile(path.join(root, 'public', 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
    await fs.writeFile(path.join(root, 'a.txt'), 'irrelevant');
    const catalog = new ProjectFaviconCatalog({ maxEntries: 1 });

    const result = await catalog.discover(project());

    expect(result.map((favicon) => favicon.path)).toEqual(['public/favicon.ico']);
  });

  it('enforces entry, file, result, and total response byte budgets together', async () => {
    await fs.mkdir(path.join(root, 'public'));
    await fs.writeFile(path.join(root, 'public', 'favicon-a.png'), Buffer.alloc(6, 1));
    await fs.writeFile(path.join(root, 'public', 'favicon-b.png'), Buffer.alloc(6, 2));
    await fs.writeFile(path.join(root, 'public', 'favicon-c.png'), Buffer.alloc(20, 3));
    const catalog = new ProjectFaviconCatalog({
      maxEntries: 3,
      maxCandidates: 3,
      maxResults: 3,
      maxFileBytes: 10,
      maxTotalBytes: 8
    });

    const result = await catalog.discover(project());

    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('public/favicon-a.png');
  });

  it('coalesces concurrent discovery for one Project identity', async () => {
    await fs.mkdir(path.join(root, 'public'));
    await fs.writeFile(path.join(root, 'public', 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
    const original = fs.readdir.bind(fs);
    let publicReads = 0;
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === path.join(root, 'public')) publicReads += 1;
      return original(...args as [any, any]) as never;
    });
    const catalog = new ProjectFaviconCatalog();

    const [first, second] = await Promise.all([
      catalog.discover(project()),
      catalog.discover(project())
    ]);

    expect(publicReads).toBe(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('rejects traversal and symlink escape when reading a selected asset', async () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.png`);
    await fs.writeFile(outside, Buffer.from([1, 2, 3]));
    await fs.symlink(outside, path.join(root, 'favicon.png'));
    const catalog = new ProjectFaviconCatalog();

    try {
      await expect(catalog.read(project(), '../outside.png')).resolves.toBeNull();
      await expect(catalog.read(project(), 'favicon.png')).resolves.toBeNull();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

function project(): Project {
  const now = new Date().toISOString();
  return {
    id: 'project',
    name: 'Project',
    path: root,
    createdAt: now,
    lastOpenedAt: now
  };
}
