import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentObserverManager } from '../agents/AgentObserverManager.js';
import { AgentRuntimeManager } from '../agents/AgentRuntimeManager.js';
import { SoloeMcpServer } from '../agents/SoloeMcpServer.js';
import { ArtifactMcpTools } from './ArtifactMcpTools.js';
import { ArtifactStore } from './ArtifactStore.js';

let projectDir: string;
let dataDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-artifacts-integration-project-'));
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-artifacts-integration-data-'));
});

afterEach(async () => {
  await Promise.all([
    fs.rm(projectDir, { recursive: true, force: true }),
    fs.rm(dataDir, { recursive: true, force: true })
  ]);
});

describe('Artifacts MCP vertical slice', () => {
  it('publishes, emits, lists, reads durable files, and deletes through real MCP routing', async () => {
    const project = {
      id: 'mcp-project',
      name: 'MCP Project',
      path: projectDir,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastOpenedAt: '2026-01-01T00:00:00.000Z'
    };
    const store = new ArtifactStore(path.join(dataDir, 'artifacts'));
    const events: string[] = [];
    store.onChange((event) => events.push(event.snapshot.revision));
    const artifactTools = new ArtifactMcpTools({
      store,
      projects: {
        get: async (id) => id === project.id ? project : null,
        detectFromPath: async () => ({ path: projectDir, matchedProjectId: project.id })
      }
    });
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer });
    const mcp = new SoloeMcpServer({ observer, runtime, artifacts: artifactTools });
    try {
      const published = await mcp.handlePayload({
        tool: 'publish_artifact',
        arguments: {
          cwd: projectDir,
          id: 'launch-plan',
          title: 'Launch plan',
          description: 'Milestones and readiness criteria.',
          html: '<!doctype html><h1>Launch plan</h1>'
        }
      }) as { artifact: { id: string }; homeGenerated: boolean };
      expect(published).toMatchObject({
        artifact: { id: 'launch-plan' },
        homeGenerated: true
      });
      expect(events).toHaveLength(1);

      const storage = path.join(dataDir, 'artifacts', project.id);
      await expect(fs.readFile(path.join(storage, 'launch-plan.html'), 'utf8'))
        .resolves.toContain('Launch plan');
      await expect(fs.readFile(path.join(storage, 'home.html'), 'utf8'))
        .resolves.toContain('Milestones and readiness criteria.');
      await expect(fs.readFile(path.join(storage, 'index.json'), 'utf8'))
        .resolves.toContain('launch-plan');

      const listed = await mcp.handlePayload({
        tool: 'list_artifacts', arguments: { cwd: projectDir }
      });
      expect(JSON.stringify(listed)).not.toContain('<!doctype html><h1>Launch plan</h1>');

      const deleted = await mcp.handlePayload({
        tool: 'delete_artifact', arguments: { cwd: projectDir, id: 'launch-plan' }
      }) as { deleted: boolean };
      expect(deleted.deleted).toBe(true);
      expect(events).toHaveLength(2);
      await expect(fs.readFile(path.join(storage, 'home.html'), 'utf8'))
        .resolves.toContain('No artifacts yet');
    } finally {
      await runtime.dispose();
    }
  });
});
