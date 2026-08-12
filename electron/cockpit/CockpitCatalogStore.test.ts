import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CatalogArchiveError,
  CatalogConflictError,
  CockpitCatalogStore
} from './CockpitCatalogStore.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_A = '33333333-3333-4333-8333-333333333333';
const DEVICE_B = '44444444-4444-4444-8444-444444444444';

describe('CockpitCatalogStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('persists offline Projects, Workspaces, and collision-safe Session memberships', async () => {
    const filePath = await catalogFile(directories);
    const store = new CockpitCatalogStore(filePath, {
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
    await store.init();

    const result = await store.execute({
      expectedRevision: 0,
      mutations: [
        {
          type: 'project.create',
          project: {
            id: PROJECT_ID,
            name: 'Compiler',
            canonicalRepository: null
          }
        },
        {
          type: 'workspace.create',
          workspace: {
            id: WORKSPACE_ID,
            projectId: PROJECT_ID,
            name: 'Parser rewrite',
            source: { kind: 'branch', localRef: 'refs/heads/parser-rewrite' }
          }
        },
        {
          type: 'session.regroup',
          sessionRef: { deviceId: DEVICE_A, sessionId: 'same-id' },
          workspaceId: WORKSPACE_ID,
          order: 0
        },
        {
          type: 'session.regroup',
          sessionRef: { deviceId: DEVICE_B, sessionId: 'same-id' },
          workspaceId: WORKSPACE_ID,
          order: 1
        }
      ]
    });

    expect(result.snapshot).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      projects: [{ id: PROJECT_ID, version: 1, name: 'Compiler' }],
      workspaces: [{
        id: WORKSPACE_ID,
        projectId: PROJECT_ID,
        version: 1,
        name: 'Parser rewrite',
        source: { kind: 'branch', localRef: 'refs/heads/parser-rewrite' }
      }]
    });
    expect(result.snapshot.sessionMemberships.map((membership) => membership.sessionRef)).toEqual([
      { deviceId: DEVICE_A, sessionId: 'same-id' },
      { deviceId: DEVICE_B, sessionId: 'same-id' }
    ]);

    const restarted = new CockpitCatalogStore(filePath);
    await restarted.init();
    expect(restarted.snapshot()).toEqual(result.snapshot);
  });

  it('rejects a stale catalog transaction without partially applying it', async () => {
    const filePath = await catalogFile(directories);
    const store = new CockpitCatalogStore(filePath);
    await store.init();
    await store.execute({
      expectedRevision: 0,
      mutations: [{
        type: 'project.create',
        project: { id: PROJECT_ID, name: 'Compiler', canonicalRepository: null }
      }]
    });

    await expect(store.execute({
      expectedRevision: 0,
      mutations: [{
        type: 'project.rename',
        projectId: PROJECT_ID,
        expectedVersion: 1,
        name: 'Should not win'
      }]
    })).rejects.toBeInstanceOf(CatalogConflictError);
    expect(store.snapshot().projects[0]?.name).toBe('Compiler');
    expect(store.snapshot().revision).toBe(1);
  });

  it('publishes a Project identity without replacing its opaque Project ID', async () => {
    const filePath = await catalogFile(directories);
    const store = new CockpitCatalogStore(filePath);
    await store.init();
    await store.execute({
      expectedRevision: 0,
      mutations: [{
        type: 'project.create',
        project: {
          id: PROJECT_ID,
          name: 'Compiler',
          canonicalRepository: {
            kind: 'unpublished',
            localIdentityId: '55555555-5555-4555-8555-555555555555'
          }
        }
      }]
    });

    const result = await store.execute({
      expectedRevision: 1,
      mutations: [{
        type: 'project.repository',
        projectId: PROJECT_ID,
        expectedVersion: 1,
        canonicalRepository: {
          kind: 'git',
          canonicalUrl: 'https://github.com/soloe/compiler',
          provider: 'github',
          providerRepositoryId: 'R_test'
        }
      }]
    });

    expect(result.snapshot.projects[0]).toMatchObject({
      id: PROJECT_ID,
      version: 2,
      canonicalRepository: {
        kind: 'git',
        canonicalUrl: 'https://github.com/soloe/compiler'
      },
      repositoryAliases: [{
        kind: 'unpublished',
        localIdentityId: '55555555-5555-4555-8555-555555555555'
      }]
    });
  });

  it('blocks cross-Project regroup so drag cannot imply physical Session movement', async () => {
    const filePath = await catalogFile(directories);
    const store = new CockpitCatalogStore(filePath);
    await store.init();
    const otherProjectId = '55555555-5555-4555-8555-555555555555';
    const otherWorkspaceId = '66666666-6666-4666-8666-666666666666';
    await store.execute({
      expectedRevision: 0,
      mutations: [
        { type: 'project.create', project: { id: PROJECT_ID, name: 'One', canonicalRepository: null } },
        { type: 'project.create', project: { id: otherProjectId, name: 'Two', canonicalRepository: null } },
        {
          type: 'workspace.create',
          workspace: {
            id: WORKSPACE_ID,
            projectId: PROJECT_ID,
            name: 'one',
            source: { kind: 'revision', oid: '0123456789012345678901234567890123456789' }
          }
        },
        {
          type: 'workspace.create',
          workspace: {
            id: otherWorkspaceId,
            projectId: otherProjectId,
            name: 'two',
            source: { kind: 'revision', oid: '1123456789012345678901234567890123456789' }
          }
        },
        {
          type: 'session.regroup',
          sessionRef: { deviceId: DEVICE_A, sessionId: 'same-id' },
          workspaceId: WORKSPACE_ID
        }
      ]
    });

    await expect(store.execute({
      expectedRevision: 1,
      mutations: [{
        type: 'session.regroup',
        sessionRef: { deviceId: DEVICE_A, sessionId: 'same-id' },
        workspaceId: otherWorkspaceId
      }]
    })).rejects.toThrow('Successor Session');
    expect(store.snapshot().sessionMemberships[0]?.workspaceId).toBe(WORKSPACE_ID);
  });

  it('exports and atomically imports a checksummed portable catalog', async () => {
    const sourcePath = await catalogFile(directories);
    const destinationPath = await catalogFile(directories);
    const source = new CockpitCatalogStore(sourcePath, {
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
    const destination = new CockpitCatalogStore(destinationPath, {
      now: () => new Date('2026-08-12T13:00:00.000Z')
    });
    await source.init();
    await destination.init();
    await source.execute({
      expectedRevision: 0,
      mutations: [{
        type: 'project.create',
        project: { id: PROJECT_ID, name: 'Portable compiler', canonicalRepository: null }
      }]
    });

    const bundle = source.exportBundle(
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666'
    );
    const imported = await destination.importBundle({
      bundle,
      expectedRevision: 0,
      replace: true
    });

    expect(bundle.manifest).toEqual({
      schemaVersion: 1,
      cockpitId: '55555555-5555-4555-8555-555555555555',
      exportEpoch: '66666666-6666-4666-8666-666666666666',
      exportedAt: '2026-08-12T12:00:00.000Z',
      catalogSchemaVersion: 1,
      catalogRevision: 1,
      checksum: { algorithm: 'sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/u) }
    });
    expect(imported).toMatchObject({
      sourceCockpitId: bundle.manifest.cockpitId,
      exportEpoch: bundle.manifest.exportEpoch,
      backupPath: expect.stringContaining('.pre-import-'),
      snapshot: {
        revision: 2,
        projects: [{ id: PROJECT_ID, name: 'Portable compiler' }]
      }
    });
    const restarted = new CockpitCatalogStore(destinationPath);
    await restarted.init();
    expect(restarted.snapshot()).toEqual(imported.snapshot);
  });

  it('rejects corrupt and unsupported catalog bundles without changing current state', async () => {
    const filePath = await catalogFile(directories);
    const store = new CockpitCatalogStore(filePath);
    await store.init();
    await store.execute({
      expectedRevision: 0,
      mutations: [{
        type: 'project.create',
        project: { id: PROJECT_ID, name: 'Keep me', canonicalRepository: null }
      }]
    });
    const before = store.snapshot();
    const bundle = store.exportBundle('55555555-5555-4555-8555-555555555555');
    const corrupt = structuredClone(bundle);
    corrupt.catalog.projects[0]!.name = 'Tampered';

    await expect(store.importBundle({
      bundle: corrupt,
      expectedRevision: before.revision,
      replace: true
    })).rejects.toMatchObject({ code: 'catalog_archive_checksum_mismatch' });
    const unsupported = structuredClone(bundle) as unknown as {
      manifest: { schemaVersion: number };
    };
    unsupported.manifest.schemaVersion = 2;
    await expect(store.importBundle({
      bundle: unsupported as never,
      expectedRevision: before.revision,
      replace: true
    })).rejects.toBeInstanceOf(CatalogArchiveError);
    expect(store.snapshot()).toEqual(before);
  });
});

async function catalogFile(directories: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-catalog-'));
  directories.push(directory);
  return path.join(directory, 'cockpit-catalog.json');
}
