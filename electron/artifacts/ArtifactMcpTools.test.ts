import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactStore } from './ArtifactStore.js';
import { ArtifactMcpTools } from './ArtifactMcpTools.js';

const project = {
  id: 'known-project',
  name: 'Known Project',
  path: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z'
};
let root: string;
let dataDir: string;
let tools: ArtifactMcpTools;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-artifact-mcp-project-'));
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-artifact-mcp-data-'));
  project.path = root;
  tools = new ArtifactMcpTools({
    store: new ArtifactStore(dataDir),
    projects: {
      get: async (id) => id === project.id ? project : null,
      detectFromPath: async (cwd) => ({
        path: root,
        matchedProjectId: cwd.startsWith(root) ? project.id : null
      })
    }
  });
});

afterEach(async () => {
  await Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]);
});

describe('ArtifactMcpTools', () => {
  it('publishes inline HTML and lists metadata without HTML bodies', async () => {
    const published = await tools.publish({
      cwd: root,
      id: 'research',
      title: 'Research report',
      description: 'Concise findings from primary sources.',
      html: '<h1>Findings</h1>'
    });
    const listed = await tools.list({ cwd: root });

    expect(published.artifact.id).toBe('research');
    expect(listed.artifacts.some((artifact) => artifact.id === 'research')).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('<h1>Findings</h1>');
  });

  it('reads a nested local .html source inside the resolved Project', async () => {
    const nested = path.join(root, 'output');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'report.html'), '<main>From file</main>');

    const published = await tools.publish({
      cwd: nested,
      title: 'File report',
      description: 'Published from a local HTML file.',
      path: 'report.html'
    });

    expect(published.artifact.title).toBe('File report');
  });

  it('rejects source traversal, symlink escape, and non-html files', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-artifact-outside-'));
    try {
      const secret = path.join(outside, 'secret.html');
      await fs.writeFile(secret, '<p>secret</p>');
      await fs.symlink(secret, path.join(root, 'linked.html'));
      const base = {
        cwd: root,
        title: 'Unsafe',
        description: 'Must remain inside the Project.'
      };
      await expect(tools.publish({ ...base, path: secret })).rejects.toThrow(/escapes/iu);
      await expect(tools.publish({ ...base, path: 'linked.html' })).rejects.toThrow(/escapes/iu);
      await expect(tools.publish({ ...base, path: 'report.htm' })).rejects.toThrow(/\.html/iu);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('requires exactly one HTML source and a registered Project cwd', async () => {
    const base = {
      cwd: root,
      title: 'Boundary report',
      description: 'Exercises input parsing.'
    };
    await expect(tools.publish({ ...base })).rejects.toThrow(/exactly one/iu);
    await expect(tools.publish({ ...base, html: '<p>x</p>', path: 'x.html' }))
      .rejects.toThrow(/exactly one/iu);
    await expect(tools.list({ cwd: path.dirname(root) })).rejects.toThrow(/registered Soloe Project/iu);
  });
});

