import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '@shared/types/projects.js';
import type { Session } from '@shared/types/sessions.js';
import { WorkspaceDeviceStore } from './WorkspaceDeviceStore.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

describe('WorkspaceDeviceStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('adopts paths into stable Device-owned Repository and Checkout identities', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-device-workspaces-'));
    directories.push(directory);
    const filePath = path.join(directory, 'device-workspaces.json');
    const store = new WorkspaceDeviceStore(filePath, DEVICE_ID, {
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });
    await store.init();

    const migrated = await store.adoptLegacy({
      migrationKey: 'legacy-v1',
      projects: [legacyProject()],
      sessions: [
        legacySession('main', '/repo', 'linux'),
        legacySession('feature', '/repo-feature', 'linux'),
        legacySession('wsl-a', '/repo-feature', 'wsl', 'Ubuntu'),
        legacySession('wsl-b', '/repo-feature', 'wsl', 'Debian')
      ]
    });

    expect(migrated.snapshot.repositories).toHaveLength(1);
    expect(migrated.snapshot.checkouts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/repo', role: 'main', runMode: 'linux' }),
      expect.objectContaining({ path: '/repo-feature', role: 'workspace', runMode: 'linux' }),
      expect.objectContaining({ path: '/repo-feature', role: 'workspace', runMode: 'wsl', wslDistro: 'Ubuntu' }),
      expect.objectContaining({ path: '/repo-feature', role: 'workspace', runMode: 'wsl', wslDistro: 'Debian' })
    ]));
    expect(new Set(migrated.snapshot.checkouts.map((checkout) => checkout.id)).size).toBe(4);
    expect(migrated.sessionSources).toHaveLength(4);

    const restarted = new WorkspaceDeviceStore(filePath, DEVICE_ID);
    await restarted.init();
    const repeated = await restarted.adoptLegacy({
      migrationKey: 'legacy-v1',
      projects: [legacyProject()],
      sessions: [
        legacySession('main', '/repo', 'linux'),
        legacySession('feature', '/repo-feature', 'linux'),
        legacySession('wsl-a', '/repo-feature', 'wsl', 'Ubuntu'),
        legacySession('wsl-b', '/repo-feature', 'wsl', 'Debian')
      ]
    });
    expect(repeated).toEqual(migrated);
  });

  it('binds standalone legacy Sessions sharing a physical Checkout to one Repository', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-device-workspaces-'));
    directories.push(directory);
    const store = new WorkspaceDeviceStore(
      path.join(directory, 'device-workspaces.json'),
      DEVICE_ID,
      { now: () => new Date('2026-08-13T05:45:53.663Z') }
    );
    await store.init();

    const migrated = await store.adoptLegacy({
      migrationKey: 'legacy-projects-sessions-v1',
      projects: [],
      sessions: [
        standaloneLegacySession('dune', '~'),
        standaloneLegacySession('sage', '~'),
        standaloneLegacySession('frost', '~')
      ]
    });

    expect(migrated.snapshot.repositories).toHaveLength(1);
    expect(migrated.snapshot.checkouts).toHaveLength(1);
    expect(migrated.snapshot.checkouts[0]).toMatchObject({
      path: '~',
      runMode: 'macos',
      role: 'external'
    });
    expect(migrated.sessionSources.map(({ sessionId }) => sessionId)).toEqual([
      'dune',
      'sage',
      'frost'
    ]);
    expect(
      new Set(migrated.sessionSources.map(({ source }) => source.checkoutId))
    ).toEqual(new Set([migrated.snapshot.checkouts[0]!.id]));
  });

  it('reconciles newly-created legacy Sessions without duplicating stable records', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-device-workspaces-'));
    directories.push(directory);
    const store = new WorkspaceDeviceStore(
      path.join(directory, 'device-workspaces.json'),
      DEVICE_ID
    );
    await store.init();
    await store.adoptLegacy({
      migrationKey: 'legacy-v1',
      projects: [legacyProject()],
      sessions: [legacySession('main', '/repo', 'linux')]
    });

    const first = await store.reconcileLegacy({
      projects: [legacyProject()],
      sessions: [
        legacySession('main', '/repo', 'linux'),
        legacySession('later', '/repo-later', 'linux')
      ]
    });
    const revision = first.snapshot.revision;
    const repeated = await store.reconcileLegacy({
      projects: [legacyProject()],
      sessions: [
        legacySession('main', '/repo', 'linux'),
        legacySession('later', '/repo-later', 'linux')
      ]
    });

    expect(first.snapshot.checkouts).toHaveLength(2);
    expect(first.sessionSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'later' })
    ]));
    expect(repeated.snapshot.revision).toBe(revision);
    expect(repeated.snapshot).toEqual(first.snapshot);
  });

  it('persists pending Checkouts before effects and updates them optimistically', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-device-workspaces-'));
    directories.push(directory);
    const store = new WorkspaceDeviceStore(
      path.join(directory, 'device-workspaces.json'),
      DEVICE_ID
    );
    await store.init();
    const adopted = await store.adoptLegacy({
      migrationKey: 'legacy-v1',
      projects: [legacyProject()],
      sessions: []
    });
    const repositoryId = adopted.projectRepositories.compiler!;

    const pending = await store.registerCheckout({
      expectedRevision: adopted.snapshot.revision,
      checkout: {
        id: '99999999-9999-4999-8999-999999999999',
        repositoryId,
        path: '/repo-feature',
        runMode: 'linux',
        role: 'workspace',
        lifecycle: 'pending'
      }
    });
    const ready = await store.updateCheckout({
      expectedRevision: pending.revision,
      checkoutId: '99999999-9999-4999-8999-999999999999',
      expectedVersion: 1,
      lifecycle: 'ready'
    });

    expect(ready.checkouts).toContainEqual(expect.objectContaining({
      id: '99999999-9999-4999-8999-999999999999',
      lifecycle: 'ready',
      version: 2
    }));
    await expect(store.updateCheckout({
      expectedRevision: pending.revision,
      checkoutId: '99999999-9999-4999-8999-999999999999',
      expectedVersion: 1,
      lifecycle: 'missing'
    })).rejects.toThrow('revision');
  });

  it('atomically registers a cloned Repository and its pending main Checkout', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-device-workspaces-'));
    directories.push(directory);
    const store = new WorkspaceDeviceStore(
      path.join(directory, 'device-workspaces.json'),
      DEVICE_ID
    );
    await store.init();

    const snapshot = await store.registerRepository({
      expectedRevision: 0,
      repository: {
        id: '22222222-2222-4222-8222-222222222222',
        identity: { kind: 'git', canonicalUrl: 'https://github.com/acme/compiler.git' }
      },
      mainCheckout: {
        id: '33333333-3333-4333-8333-333333333333',
        repositoryId: '22222222-2222-4222-8222-222222222222',
        path: '/managed/compiler',
        runMode: 'linux',
        role: 'main',
        lifecycle: 'pending'
      }
    });

    expect(snapshot).toMatchObject({
      revision: 1,
      repositories: [{ id: '22222222-2222-4222-8222-222222222222' }],
      checkouts: [{
        id: '33333333-3333-4333-8333-333333333333',
        repositoryId: '22222222-2222-4222-8222-222222222222',
        lifecycle: 'pending'
      }]
    });
  });
});

function legacyProject(): Project {
  return {
    id: 'compiler',
    name: 'Compiler',
    path: '/repo',
    defaultRunMode: 'linux',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastOpenedAt: '2025-01-02T00:00:00.000Z'
  };
}

function legacySession(
  id: string,
  cwd: string,
  runMode: Session['runMode'],
  wslDistro?: string
): Session {
  return {
    id,
    name: id,
    cwd,
    runMode,
    ...(wslDistro ? { wslDistro } : {}),
    projectId: 'compiler',
    launch: { type: 'terminal', shell: 'auto' },
    createdAt: '2025-01-01T00:00:00.000Z',
    lastUsedAt: '2025-01-02T00:00:00.000Z'
  };
}

function standaloneLegacySession(id: string, cwd: string): Session {
  return {
    id,
    name: id,
    cwd,
    runMode: 'macos',
    launch: { type: 'terminal', shell: 'auto' },
    createdAt: '2025-01-01T00:00:00.000Z',
    lastUsedAt: '2025-01-02T00:00:00.000Z'
  };
}
