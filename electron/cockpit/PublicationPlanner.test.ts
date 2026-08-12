import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DevicePort } from './DevicePort.js';
import { CockpitCatalogStore } from './CockpitCatalogStore.js';
import { CockpitOperationStore } from './CockpitOperationStore.js';
import { PublicationPlanner } from './PublicationPlanner.js';

const COCKPIT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const CHECKOUT_ID = '55555555-5555-4555-8555-555555555555';
const REPOSITORY_ID = '66666666-6666-4666-8666-666666666666';
const HEAD_OID = '0123456789012345678901234567890123456789';
const directories: string[] = [];

describe('PublicationPlanner', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('creates the GitHub repository, records Project identity, then publishes the Branch', async () => {
    const fixture = await createFixture();
    const plan = await fixture.planner.plan(intent());

    expect(plan).toMatchObject({
      executable: true,
      preview: { visibility: 'private', localOid: HEAD_OID },
      providerPlan: { intent: { kind: 'create-github-repository' } },
      devicePlan: { intent: { kind: 'publish-new-remote-branch' } }
    });
    const operation = await fixture.planner.execute(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );

    expect(operation).toMatchObject({ state: 'succeeded', result: { pushed: true } });
    expect(fixture.order).toEqual(['provider', 'push']);
    expect(fixture.catalog.snapshot().projects[0]).toMatchObject({
      id: PROJECT_ID,
      canonicalRepository: {
        kind: 'git',
        provider: 'github',
        providerRepositoryId: 'R_compiler'
      }
    });
  });

  it('keeps the created remote and published Project identity visible when push fails', async () => {
    const fixture = await createFixture({ failPush: true });
    const plan = await fixture.planner.plan(intent());

    await expect(fixture.planner.execute(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    )).rejects.toThrow('push denied');

    expect(fixture.catalog.snapshot().projects[0]?.canonicalRepository).toMatchObject({
      kind: 'git',
      providerRepositoryId: 'R_compiler'
    });
    expect(fixture.operations.listRecoverable()[0]).toMatchObject({
      state: 'needs-attention',
      phase: 'push-failed',
      result: { pushed: false, pushReceipt: null }
    });
  });
});

async function createFixture(options: { failPush?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-publication-planner-'));
  directories.push(directory);
  const catalog = new CockpitCatalogStore(path.join(directory, 'catalog.json'));
  const operations = new CockpitOperationStore(path.join(directory, 'operations.json'));
  await Promise.all([catalog.init(), operations.init()]);
  await catalog.execute({
    expectedRevision: 0,
    mutations: [
      {
        type: 'project.create',
        project: {
          id: PROJECT_ID,
          name: 'Compiler',
          canonicalRepository: {
            kind: 'unpublished',
            localIdentityId: '77777777-7777-4777-8777-777777777777'
          }
        }
      },
      {
        type: 'presence.link',
        projectId: PROJECT_ID,
        repository: { deviceId: DEVICE_ID, repositoryId: REPOSITORY_ID },
        adoptedFromEvidence: null
      },
      {
        type: 'workspace.create',
        workspace: {
          id: WORKSPACE_ID,
          projectId: PROJECT_ID,
          name: 'main',
          source: { kind: 'branch', localRef: 'refs/heads/main' }
        }
      },
      {
        type: 'location.link',
        location: {
          id: '88888888-8888-4888-8888-888888888888',
          workspaceId: WORKSPACE_ID,
          checkout: { deviceId: DEVICE_ID, checkoutId: CHECKOUT_ID },
          state: 'available'
        }
      }
    ]
  });
  const order: string[] = [];
  const device = publicationDevice(order, options.failPush);
  const planner = new PublicationPlanner({
    cockpitId: COCKPIT_ID,
    catalog,
    operations,
    getDevice: (deviceId) => deviceId === DEVICE_ID ? device : null,
    now: () => new Date('2026-08-12T12:00:00.000Z')
  });
  return { planner, catalog, operations, order };
}

function intent() {
  return {
    kind: 'publish-project' as const,
    workspaceId: WORKSPACE_ID,
    sourceDeviceId: DEVICE_ID,
    owner: 'soloe',
    name: 'compiler',
    visibility: 'private' as const
  };
}

function publicationDevice(order: string[], failPush = false): DevicePort {
  const descriptor = {
    schemaVersion: 1 as const,
    deviceId: DEVICE_ID,
    name: 'Source Device',
    platform: 'linux' as const,
    serverEpoch: '99999999-9999-4999-8999-999999999999',
    service: { name: 'soloe-server' as const, version: '0.1.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: { revision: 'publication-v1', features: ['github-provider-plan.v1'] }
  };
  return {
    deviceId: DEVICE_ID,
    status: { deviceId: DEVICE_ID, state: 'ready', descriptor },
    connect: async () => ({ deviceId: DEVICE_ID, state: 'ready', descriptor }),
    snapshot: async () => ({
      descriptor,
      workspace: null,
      sessions: [], archivedSessions: [], runtimes: [], capturedAt: '2026-08-12T12:00:00.000Z'
    }),
    githubProviderPlan: vi.fn(async (providerIntent) => ({
      schemaVersion: 1 as const,
      planId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      planToken: 'provider.token',
      targetDeviceId: DEVICE_ID,
      capabilityRevision: 'publication-v1',
      intent: providerIntent,
      executable: true,
      blockers: [],
      warnings: [],
      preview: { ...providerIntent, url: 'https://github.com/soloe/compiler' },
      createdAt: '2026-08-12T12:00:00.000Z',
      expiresAt: '2026-08-12T12:05:00.000Z'
    })),
    workspacePlan: vi.fn(async (workspaceIntent) => ({
      schemaVersion: 1 as const,
      planId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      planToken: 'workspace.token',
      targetDeviceId: DEVICE_ID,
      capabilityRevision: 'publication-v1',
      expectedWorkspaceRevision: 1,
      expectedCheckoutVersion: 1,
      intent: { ...workspaceIntent, expectedLocalOid: HEAD_OID },
      executable: true,
      blockers: [],
      warnings: ['normal push only'],
      preview: { repositoryPath: '/repo', targetPath: '/repo', sourceLabel: 'refs/heads/main' },
      createdAt: '2026-08-12T12:00:00.000Z',
      expiresAt: '2026-08-12T12:05:00.000Z'
    })),
    githubProviderExecute: vi.fn(async (command) => {
      order.push('provider');
      return {
        schemaVersion: 1 as const,
        cockpitId: command.cockpitId,
        commandId: command.commandId,
        targetDeviceId: DEVICE_ID,
        kind: command.intent.kind,
        intentDigest: 'provider',
        state: 'succeeded' as const,
        createdAt: '2026-08-12T12:00:00.000Z',
        updatedAt: '2026-08-12T12:00:00.000Z',
        result: {
          provider: 'github' as const,
          providerRepositoryId: 'R_compiler',
          owner: 'soloe',
          name: 'compiler',
          visibility: 'private' as const,
          url: 'https://github.com/soloe/compiler',
          sshUrl: 'git@github.com:soloe/compiler.git'
        }
      };
    }),
    workspaceExecute: vi.fn(async (command) => {
      order.push('push');
      if (failPush) throw new Error('push denied');
      return {
        schemaVersion: 1, cockpitId: command.cockpitId, commandId: command.commandId,
        targetDeviceId: DEVICE_ID, kind: command.intent.kind, intentDigest: 'push',
        state: 'succeeded', createdAt: '2026-08-12T12:00:00.000Z',
        updatedAt: '2026-08-12T12:00:00.000Z', result: {}
      } as const;
    }),
    setTerminalOutputDemand: async () => {}, terminalInput: async () => {},
    terminalResize: async () => {}, terminalReplay: async (terminalId) => ({
      terminalRef: { deviceId: DEVICE_ID, terminalId }, sessionRef: null, snapshot: null
    }), terminalStop: async () => {}, onEvent: () => () => {}, onStatus: () => () => {}, dispose: () => {}
  };
}
