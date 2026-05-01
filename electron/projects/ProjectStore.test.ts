import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectStore } from './ProjectStore.js';
import type { ProjectDraft } from '@shared/types/projects.js';

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-projects-'));
  storePath = path.join(tmpDir, 'projects.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const draft = (overrides: Partial<ProjectDraft> = {}): ProjectDraft => ({
  name: 'Soloe',
  path: '/home/me/soloe',
  ...overrides
});

describe('ProjectStore — create/list', () => {
  it('creates a project and lists it back', async () => {
    const store = new ProjectStore(storePath);
    const created = await store.create(draft());
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('Soloe');
    expect(created.path).toBe('/home/me/soloe');
    expect(created.createdAt).toBe(created.lastOpenedAt);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);
  });

  it('generates unique ids for projects with the same name', async () => {
    const store = new ProjectStore(storePath);
    const a = await store.create(draft());
    const b = await store.create(draft());
    expect(a.id).not.toBe(b.id);
  });
});

describe('ProjectStore — validation', () => {
  it('rejects an empty name', async () => {
    const store = new ProjectStore(storePath);
    await expect(store.create(draft({ name: '   ' }))).rejects.toThrow(/name is required/);
  });

  it('rejects an empty path', async () => {
    const store = new ProjectStore(storePath);
    await expect(store.create(draft({ path: '' }))).rejects.toThrow(/path is required/);
  });

  it('rejects an invalid defaultRunMode', async () => {
    const store = new ProjectStore(storePath);
    await expect(
      store.create(draft({ defaultRunMode: 'mac' as unknown as 'wsl' }))
    ).rejects.toThrow(/Invalid defaultRunMode/);
  });
});

describe('ProjectStore — update/delete/touch', () => {
  it('updates a project and re-validates', async () => {
    const store = new ProjectStore(storePath);
    const created = await store.create(draft());
    const renamed = await store.update(created.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    await expect(store.update(created.id, { name: '' })).rejects.toThrow(/name is required/);
  });

  it('deletes a project and errors on a second delete', async () => {
    const store = new ProjectStore(storePath);
    const created = await store.create(draft());
    await store.delete(created.id);
    expect(await store.list()).toHaveLength(0);
    await expect(store.delete(created.id)).rejects.toThrow(/not found/);
  });

  it('touch advances lastOpenedAt', async () => {
    const store = new ProjectStore(storePath);
    const created = await store.create(draft());
    await new Promise((r) => setTimeout(r, 5));
    const touched = await store.touch(created.id);
    expect(touched).not.toBeNull();
    expect(touched!.lastOpenedAt > created.lastOpenedAt).toBe(true);
  });

  it('list ordering follows lastOpenedAt desc', async () => {
    const store = new ProjectStore(storePath);
    const a = await store.create(draft({ name: 'A' }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create(draft({ name: 'B' }));
    await new Promise((r) => setTimeout(r, 5));
    await store.touch(a.id);
    const list = await store.list();
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
  });
});

describe('ProjectStore — disk round-trip', () => {
  it('persists across instances pointing at the same file', async () => {
    const a = new ProjectStore(storePath);
    const created = await a.create(draft({ name: 'Persisted' }));
    const b = new ProjectStore(storePath);
    const fromDisk = await b.get(created.id);
    expect(fromDisk?.name).toBe('Persisted');
    expect((await b.list()).map((p) => p.id)).toEqual([created.id]);
  });

  it('returns an empty list when storage file does not exist', async () => {
    const store = new ProjectStore(path.join(tmpDir, 'no-such.json'));
    expect(await store.list()).toEqual([]);
  });

  it('backs up corrupt JSON and starts with an empty list', async () => {
    await fs.writeFile(storePath, '{ broken json', 'utf8');
    const store = new ProjectStore(storePath);
    expect(await store.list()).toEqual([]);
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((f) => f.startsWith('projects.json.corrupt-'))).toBe(true);
  });
});

describe('ProjectStore — onChange', () => {
  it('notifies listeners on create/update/delete', async () => {
    const store = new ProjectStore(storePath);
    const events: number[] = [];
    const off = store.onChange((projects) => events.push(projects.length));
    const created = await store.create(draft());
    await store.update(created.id, { name: 'Updated' });
    await store.delete(created.id);
    off();
    await store.create(draft({ name: 'After detach' }));
    expect(events).toEqual([1, 1, 0]);
  });
});

const hasGit = (() => {
  try {
    const r = spawnSync('git', ['--version']);
    return r.status === 0;
  } catch {
    return false;
  }
})();

describe.runIf(hasGit)('ProjectStore — detectFromPath', () => {
  it('returns toplevel and suggested name from a git repo', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-repo-'));
    try {
      const init = spawnSync('git', ['init', '-q'], { cwd: repoDir });
      expect(init.status).toBe(0);
      const sub = path.join(repoDir, 'sub');
      await fs.mkdir(sub);
      const realRepoDir = await fs.realpath(repoDir);
      const store = new ProjectStore(storePath);
      const result = await store.detectFromPath(sub);
      const realResultPath = await fs.realpath(result.path);
      expect(realResultPath).toBe(realRepoDir);
      expect(result.suggestedName).toBe(path.basename(realRepoDir));
      expect(result.matchedProjectId).toBeNull();
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('matches an existing project by normalised path', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-repo-'));
    try {
      const init = spawnSync('git', ['init', '-q'], { cwd: repoDir });
      expect(init.status).toBe(0);
      const realRepoDir = await fs.realpath(repoDir);
      const store = new ProjectStore(storePath);
      const created = await store.create(draft({ name: 'Existing', path: realRepoDir }));
      const result = await store.detectFromPath(realRepoDir);
      expect(result.matchedProjectId).toBe(created.id);
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });

  it('returns null match for a non-repo directory but uses the input path', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-plain-'));
    try {
      const store = new ProjectStore(storePath);
      const result = await store.detectFromPath(plain);
      expect(result.path).toBe(plain);
      expect(result.matchedProjectId).toBeNull();
      expect(result.suggestedName).toBe(path.basename(plain));
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it('handles empty input gracefully', async () => {
    const store = new ProjectStore(storePath);
    const result = await store.detectFromPath('');
    expect(result.path).toBe('');
    expect(result.suggestedName).toBe('');
    expect(result.matchedProjectId).toBeNull();
  });
});
