import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '@shared/types/projects.js';
import { SessionStore } from '../sessions/SessionStore.js';
import { WorkspaceDeviceStore } from '@soloe/domain';
import { CockpitCatalogStore } from './CockpitCatalogStore.js';
import { CockpitMigration } from './CockpitMigration.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const MAIN_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const MAIN_LOCATION_ID = '44444444-4444-4444-8444-444444444444';
const FEATURE_WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';
const FEATURE_LOCATION_ID = '66666666-6666-4666-8666-666666666666';

describe('CockpitMigration', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('imports physical legacy groups once without guessing or moving Sessions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-cockpit-migration-'));
    directories.push(directory);
    const sessions = new SessionStore(path.join(directory, 'sessions.json'), 'linux');
    const main = await sessions.create({
      name: 'Main shell',
      cwd: '/repo',
      runMode: 'linux',
      projectId: 'compiler',
      lastBranch: 'main',
      launch: { type: 'terminal', shell: 'auto' }
    });
    const feature = await sessions.create({
      name: 'Feature shell',
      cwd: '/repo-feature',
      runMode: 'linux',
      projectId: 'compiler',
      lastBranch: 'feature/parser',
      launch: { type: 'terminal', shell: 'auto' }
    });
    const device = new WorkspaceDeviceStore(
      path.join(directory, 'device-workspaces.json'),
      DEVICE_ID
    );
    await device.init();
    const catalog = new CockpitCatalogStore(path.join(directory, 'cockpit-catalog.json'), {
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
    await catalog.init();
    const generatedIds = [
      PROJECT_ID,
      MAIN_WORKSPACE_ID,
      MAIN_LOCATION_ID,
      FEATURE_WORKSPACE_ID,
      FEATURE_LOCATION_ID
    ];
    const migration = new CockpitMigration({
      catalog,
      deviceStore: device,
      sessions,
      resolveWorkspaceSource: async (checkout) => ({
        kind: 'branch',
        localRef: checkout.path === '/repo'
          ? 'refs/heads/main'
          : 'refs/heads/feature/parser'
      }),
      idFactory: () => generatedIds.shift()!,
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });

    const first = await migration.migrateLegacyDevice({
      migrationKey: 'legacy-linux-v1',
      projects: [legacyProject()]
    });

    expect(first.projects).toEqual([
      expect.objectContaining({ id: PROJECT_ID, name: 'Compiler' })
    ]);
    expect(first.workspaces).toEqual([
      expect.objectContaining({
        id: MAIN_WORKSPACE_ID,
        source: { kind: 'branch', localRef: 'refs/heads/main' }
      }),
      expect.objectContaining({
        id: FEATURE_WORKSPACE_ID,
        source: { kind: 'branch', localRef: 'refs/heads/feature/parser' }
      })
    ]);
    expect(first.sessionMemberships.map((membership) => membership.sessionRef)).toEqual([
      { deviceId: DEVICE_ID, sessionId: main.id },
      { deviceId: DEVICE_ID, sessionId: feature.id }
    ]);
    expect((await sessions.get(main.id))?.source).toMatchObject({
      kind: 'existing-checkout',
      adopted: true
    });
    expect((await sessions.get(main.id))?.cwd).toBe('/repo');

    const repeated = await migration.migrateLegacyDevice({
      migrationKey: 'legacy-linux-v1',
      projects: [legacyProject()]
    });
    expect(repeated).toEqual(first);
    expect(generatedIds).toEqual([]);
  });
});

function legacyProject(): Project {
  return {
    id: 'compiler',
    name: 'Compiler',
    path: '/repo',
    defaultRunMode: 'linux',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-02T00:00:00.000Z',
    sortIndex: 0,
    worktreeOrder: ['/repo', '/repo-feature']
  };
}
