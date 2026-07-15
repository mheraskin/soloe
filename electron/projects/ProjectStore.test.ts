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

describe('ProjectStore — open', () => {
  it('infers the project name from the opened path', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-open-'));
    try {
      const store = new ProjectStore(storePath);
      const opened = await store.open({ path: projectDir });
      expect(opened.name).toBe(path.basename(projectDir));
      expect(opened.path).toBe(projectDir);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('reuses an existing project record for the same path', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-open-'));
    try {
      const store = new ProjectStore(storePath);
      const created = await store.create(draft({ name: 'Existing', path: projectDir }));
      await new Promise((r) => setTimeout(r, 5));
      const opened = await store.open({ path: projectDir });
      expect(opened.id).toBe(created.id);
      expect(opened.lastOpenedAt > created.lastOpenedAt).toBe(true);
      expect(await store.list()).toHaveLength(1);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
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

  it('rejects a selected favicon path outside Project scope', async () => {
    const store = new ProjectStore(storePath);
    const created = await store.create(draft());
    await expect(
      store.update(created.id, { selectedFaviconPath: '../secret.png' })
    ).rejects.toThrow(/safe relative path/);
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

describe('ProjectStore — favicons', () => {
  it('discovers favicon assets without mutating or persisting Project metadata', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-favicons-'));
    try {
      await fs.mkdir(path.join(projectDir, 'public'), { recursive: true });
      await fs.mkdir(path.join(projectDir, 'src', 'assets'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'public', 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
      await fs.writeFile(
        path.join(projectDir, 'src', 'assets', 'apple-touch-icon.png'),
        Buffer.from([137, 80, 78, 71])
      );
      await fs.writeFile(path.join(projectDir, 'src', 'assets', 'logo.svg'), '<svg></svg>');

      const store = new ProjectStore(storePath);
      const created = await store.create(draft({ path: projectDir }));
      const metadataBefore = await fs.readFile(storePath, 'utf8');
      const changes: unknown[] = [];
      store.onChange((projects) => changes.push(projects));
      const favicons = await store.refreshFavicons(created.id);
      const updated = await store.get(created.id);

      expect(favicons.map((f) => f.path)).toEqual([
        'public/favicon.ico',
        'src/assets/apple-touch-icon.png'
      ]);
      expect(favicons[0]?.dataUrl).toMatch(/^data:image\/x-icon;base64,/);
      expect(updated?.selectedFaviconPath).toBeUndefined();
      expect(await fs.readFile(storePath, 'utf8')).toBe(metadataBefore);
      expect(changes).toEqual([]);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('reads a selected favicon on demand and preserves only its relative path', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-favicons-'));
    try {
      await fs.mkdir(path.join(projectDir, 'public'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'public', 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
      await fs.writeFile(path.join(projectDir, 'public', 'favicon.svg'), '<svg></svg>');

      const store = new ProjectStore(storePath);
      const created = await store.create(draft({ path: projectDir }));
      await store.update(created.id, { selectedFaviconPath: 'public/favicon.svg' });
      const selected = await store.readFavicon(created.id, 'public/favicon.svg');

      const updated = await store.get(created.id);
      expect(updated?.selectedFaviconPath).toBe('public/favicon.svg');
      expect(selected?.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(JSON.stringify(updated)).not.toContain('data:image');
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
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

  it('migrates legacy embedded favicon payloads to metadata-only storage', async () => {
    const now = new Date().toISOString();
    await fs.writeFile(storePath, JSON.stringify({
      version: 1,
      projects: [{
        id: 'legacy',
        name: 'Legacy',
        path: tmpDir,
        createdAt: now,
        lastOpenedAt: now,
        sortIndex: 0,
        selectedFaviconPath: 'public/favicon.ico',
        favicons: [{
          path: 'public/favicon.ico',
          label: 'favicon.ico',
          mediaType: 'image/x-icon',
          dataUrl: `data:image/x-icon;base64,${'A'.repeat(10_000)}`
        }]
      }]
    }), 'utf8');

    const store = new ProjectStore(storePath);
    await store.init();

    const project = await store.get('legacy');
    const migrated = await fs.readFile(storePath, 'utf8');
    expect(project?.selectedFaviconPath).toBe('public/favicon.ico');
    expect(migrated).not.toContain('data:image');
    expect(JSON.parse(migrated).version).toBe(2);
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

  it('keeps a linked worktree path as its own project path', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-repo-'));
    try {
      const init = spawnSync('git', ['init', '-q'], { cwd: repoDir });
      expect(init.status).toBe(0);
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      await fs.writeFile(path.join(repoDir, 'README.md'), 'hi');
      spawnSync('git', ['add', '.'], { cwd: repoDir });
      const commit = spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
      expect(commit.status).toBe(0);
      const worktreePath = path.join(path.dirname(repoDir), `${path.basename(repoDir)}-wt`);
      const wt = spawnSync(
        'git',
        ['worktree', 'add', '-q', '-b', 'feat', worktreePath],
        { cwd: repoDir }
      );
      expect(wt.status).toBe(0);
      try {
        const store = new ProjectStore(storePath);
        const result = await store.detectFromPath(worktreePath);
        const realResultPath = await fs.realpath(result.path);
        const realWorktreePath = await fs.realpath(worktreePath);
        expect(realResultPath).toBe(realWorktreePath);
        expect(result.suggestedName).toBe(path.basename(realWorktreePath));
      } finally {
        await fs.rm(worktreePath, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('ProjectStore — suggestPaths', () => {
  it('returns fuzzy known project matches and directory matches in windows scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-suggest-'));
    try {
      const alpha = path.join(root, 'alpha-app');
      const beta = path.join(root, 'beta-app');
      await fs.mkdir(alpha);
      await fs.mkdir(beta);
      const store = new ProjectStore(storePath);
      const known = await store.create(
        draft({ name: 'Beta App', path: beta, defaultRunMode: 'windows' })
      );
      const result = await store.suggestPaths(path.join(root, 'aa'), { scope: 'windows' });
      expect(result.scope).toBe('windows');
      expect(
        result.suggestions.some((s) => s.path === alpha && s.source === 'directory')
      ).toBe(true);
      expect(
        result.suggestions.some((s) => s.projectId === known.id && s.source === 'known')
      ).toBe(true);
      expect(result.suggestions.every((s) => s.scope === 'windows')).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('upgrades scope to wsl when query starts with wsl: prefix', async () => {
    const store = new ProjectStore(storePath);
    const result = await store.suggestPaths('wsl:/no-such-path-xyz', {
      scope: 'windows',
      wslDistro: 'Ubuntu'
    });
    expect(result.scope).toBe('wsl');
    expect(result.wslDistro).toBe('Ubuntu');
  });

  it('upgrades scope to wsl when query is a UNC \\\\wsl$ path and parses the distro', async () => {
    const store = new ProjectStore(storePath);
    const result = await store.suggestPaths('\\\\wsl$\\Debian\\home\\me', {
      scope: 'windows'
    });
    expect(result.scope).toBe('wsl');
    expect(result.wslDistro).toBe('Debian');
  });

  it('downgrades scope to windows when query starts with win: prefix', async () => {
    const store = new ProjectStore(storePath);
    const result = await store.suggestPaths('win:C:\\no-such-path-xyz', { scope: 'wsl' });
    expect(result.scope).toBe('windows');
    expect(result.wslDistro).toBeUndefined();
  });

  it('respects explicit scope when no prefix is present', async () => {
    const store = new ProjectStore(storePath);
    const result = await store.suggestPaths('/home/no-such', {
      scope: 'windows',
      wslDistro: 'Ubuntu'
    });
    expect(result.scope).toBe('windows');
  });

  it('treats non-absolute queries as home-relative in windows scope', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const target = path.join(fakeHome, 'soloe-rel-target');
      await fs.mkdir(target);
      const store = new ProjectStore(storePath);
      const fragmentResult = await store.suggestPaths('soloe-rel', { scope: 'windows' });
      expect(fragmentResult.scope).toBe('windows');
      expect(
        fragmentResult.suggestions.some(
          (s) => s.path === target && s.source === 'directory'
        )
      ).toBe(true);
      const drilledResult = await store.suggestPaths('soloe-rel-target/', {
        scope: 'windows'
      });
      expect(drilledResult.scope).toBe('windows');
      expect(drilledResult.suggestions).toEqual([]);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('auto-expands the only matching directory under home', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const projectsDir = path.join(fakeHome, 'soloe-rel-projects');
      const snpDir = path.join(fakeHome, 'soloe-rel-snp');
      await fs.mkdir(projectsDir);
      await fs.mkdir(snpDir);
      const alpha = path.join(projectsDir, 'alpha');
      const beta = path.join(projectsDir, 'beta');
      await fs.mkdir(alpha);
      await fs.mkdir(beta);
      const store = new ProjectStore(storePath);
      const result = await store.suggestPaths('soloe-rel-proj', { scope: 'windows' });
      const paths = result.suggestions.map((s) => s.path);
      expect(paths).toContain(projectsDir);
      expect(paths).toContain(alpha);
      expect(paths).toContain(beta);
      expect(paths).not.toContain(snpDir);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not auto-expand when multiple directories match the fragment', async () => {
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const projectsDir = path.join(fakeHome, 'soloe-rel-projects');
      const projetzDir = path.join(fakeHome, 'soloe-rel-projetz');
      await fs.mkdir(projectsDir);
      await fs.mkdir(projetzDir);
      const child = path.join(projectsDir, 'alpha');
      await fs.mkdir(child);
      const store = new ProjectStore(storePath);
      const result = await store.suggestPaths('soloe-rel-pro', { scope: 'windows' });
      const paths = result.suggestions.map((s) => s.path);
      expect(paths).toContain(projectsDir);
      expect(paths).toContain(projetzDir);
      expect(paths).not.toContain(child);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('filters known projects by scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-suggest-'));
    try {
      const winProject = path.join(root, 'win-proj');
      await fs.mkdir(winProject);
      const store = new ProjectStore(storePath);
      await store.create(
        draft({ name: 'Win Proj', path: winProject, defaultRunMode: 'windows' })
      );
      await store.create(
        draft({
          name: 'Wsl Proj',
          path: '/home/me/wsl-proj',
          defaultRunMode: 'wsl',
          defaultWslDistro: 'Ubuntu'
        })
      );
      const winResult = await store.suggestPaths('proj', { scope: 'windows' });
      expect(
        winResult.suggestions.some((s) => s.source === 'known' && s.scope === 'wsl')
      ).toBe(false);
      const wslResult = await store.suggestPaths('proj', {
        scope: 'wsl',
        wslDistro: 'Ubuntu'
      });
      expect(
        wslResult.suggestions.some((s) => s.source === 'known' && s.scope === 'windows')
      ).toBe(false);
      expect(
        wslResult.suggestions.some(
          (s) => s.source === 'known' && s.path === '/home/me/wsl-proj'
        )
      ).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
