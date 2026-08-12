import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DevicePort } from './DevicePort.js';
import { CockpitCatalogStore } from './CockpitCatalogStore.js';
import { CockpitOperationStore } from './CockpitOperationStore.js';
import { SourceLifecyclePlanner } from './SourceLifecyclePlanner.js';

const COCKPIT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CHECKOUT_ID = '66666666-6666-4666-8666-666666666666';
const REPOSITORY_ID = '77777777-7777-4777-8777-777777777777';
const directories: string[] = [];

describe('SourceLifecyclePlanner', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('links an ordinary Location before clearing ownership and reclassifying Session Source', async () => {
    const fixture = await createFixture();
    const plan = await fixture.planner.plan({
      kind: 'promote-isolated-source',
      sessionRef: { deviceId: DEVICE_ID, sessionId: SESSION_ID }
    });

    expect(plan).toMatchObject({
      executable: true,
      preview: { workspaceId: WORKSPACE_ID, locationId: expect.any(String) },
      devicePlan: { intent: { kind: 'promote-isolated-checkout' } }
    });
    const operation = await fixture.planner.execute(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );

    expect(operation).toMatchObject({ state: 'succeeded', result: { locationId: plan.preview.locationId } });
    expect(fixture.order).toEqual(['catalog', 'promote', 'rebind']);
    expect(fixture.rebind).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      expectedVersion: 2,
      source: {
        kind: 'workspace-location',
        checkoutId: CHECKOUT_ID,
        locationCorrelation: plan.preview.locationId
      }
    });
  });

  it('cleans an archived isolated source only through the Device loss-checked plan', async () => {
    const fixture = await createFixture({ archived: true });
    const plan = await fixture.planner.plan({
      kind: 'cleanup-isolated-source',
      sessionRef: { deviceId: DEVICE_ID, sessionId: SESSION_ID }
    });

    expect(plan).toMatchObject({
      executable: true,
      preview: { locationId: null },
      devicePlan: { intent: { kind: 'cleanup-isolated-checkout' } }
    });
    const operation = await fixture.planner.execute(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );

    expect(operation).toMatchObject({ state: 'succeeded', result: { locationId: null, session: null } });
    expect(fixture.order).toEqual(['cleanup']);
    expect(fixture.rebind).not.toHaveBeenCalled();
  });
});

async function createFixture(options: { archived?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-source-lifecycle-'));
  directories.push(directory);
  const catalog = new CockpitCatalogStore(path.join(directory, 'catalog.json'));
  const operations = new CockpitOperationStore(path.join(directory, 'operations.json'));
  await Promise.all([catalog.init(), operations.init()]);
  await catalog.execute({
    expectedRevision: 0,
    mutations: [
      { type: 'project.create', project: { id: PROJECT_ID, name: 'Compiler', canonicalRepository: null } },
      {
        type: 'workspace.create',
        workspace: {
          id: WORKSPACE_ID,
          projectId: PROJECT_ID,
          name: 'experiment',
          source: { kind: 'branch', localRef: 'refs/heads/experiment' }
        }
      },
      {
        type: 'session.regroup',
        sessionRef: { deviceId: DEVICE_ID, sessionId: SESSION_ID },
        workspaceId: WORKSPACE_ID
      }
    ]
  });
  const order: string[] = [];
  const rebind = vi.fn(async (request) => ({ ...isolatedSession(), version: 3, source: request.source }));
  const device = lifecycleDevice(order, rebind, options.archived);
  const planner = new SourceLifecyclePlanner({
    cockpitId: COCKPIT_ID,
    catalog,
    operations,
    getDevice: (deviceId) => deviceId === DEVICE_ID ? device : null,
    now: () => new Date('2026-08-12T12:00:00.000Z')
  });
  if (!options.archived) catalog.onChange(() => order.push('catalog'));
  return { planner, order, rebind };
}

function lifecycleDevice(
  order: string[],
  rebind: (request: any) => Promise<any>,
  archived = false
): DevicePort {
  const descriptor = {
    schemaVersion: 1 as const,
    deviceId: DEVICE_ID,
    name: 'Build Device',
    platform: 'linux' as const,
    serverEpoch: '88888888-8888-4888-8888-888888888888',
    service: { name: 'soloe-server' as const, version: '0.1.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: { revision: 'lifecycle-v1', features: ['workspace-lifecycle-plan.v1'] }
  };
  const session = { ...isolatedSession(), ...(archived ? { archivedAt: '2026-08-12T12:05:00.000Z' } : {}) };
  return {
    deviceId: DEVICE_ID,
    status: { deviceId: DEVICE_ID, state: 'ready', descriptor },
    connect: async () => ({ deviceId: DEVICE_ID, state: 'ready', descriptor }),
    snapshot: async () => ({
      descriptor,
      workspace: {
        schemaVersion: 1,
        revision: 1,
        deviceId: DEVICE_ID,
        repositories: [],
        checkouts: [{
          id: CHECKOUT_ID,
          repositoryId: REPOSITORY_ID,
          path: '/managed/isolated',
          runMode: 'linux',
          role: 'isolated-session',
          ownerSessionId: SESSION_ID,
          lifecycle: 'ready',
          version: 2,
          createdAt: '2026-08-12T12:00:00.000Z',
          updatedAt: '2026-08-12T12:00:00.000Z'
        }]
      },
      sessions: archived ? [] : [session],
      archivedSessions: archived ? [session] : [],
      runtimes: [],
      capturedAt: '2026-08-12T12:00:00.000Z'
    }),
    workspacePlan: vi.fn(async (intent) => ({
      schemaVersion: 1 as const,
      planId: '99999999-9999-4999-8999-999999999999',
      planToken: 'lifecycle.token',
      targetDeviceId: DEVICE_ID,
      capabilityRevision: 'lifecycle-v1',
      expectedWorkspaceRevision: 1,
      intent,
      executable: true,
      blockers: [],
      warnings: ['fresh loss evidence'],
      preview: { repositoryPath: '/repo', targetPath: '/managed/isolated', sourceLabel: intent.kind },
      createdAt: '2026-08-12T12:00:00.000Z',
      expiresAt: '2026-08-12T12:05:00.000Z'
    })),
    workspaceExecute: vi.fn(async (command) => {
      order.push(command.intent.kind === 'promote-isolated-checkout' ? 'promote' : 'cleanup');
      return {
        schemaVersion: 1, cockpitId: command.cockpitId, commandId: command.commandId,
        targetDeviceId: DEVICE_ID, kind: command.intent.kind, intentDigest: 'lifecycle',
        state: 'succeeded', createdAt: '2026-08-12T12:00:00.000Z',
        updatedAt: '2026-08-12T12:00:00.000Z', result: {}
      } as const;
    }),
    rebindSessionSource: vi.fn(async (request) => {
      order.push('rebind');
      return rebind(request);
    }),
    setTerminalOutputDemand: async () => {}, terminalInput: async () => {},
    terminalResize: async () => {}, terminalReplay: async (terminalId) => ({
      terminalRef: { deviceId: DEVICE_ID, terminalId }, sessionRef: null, snapshot: null
    }), terminalStop: async () => {}, onEvent: () => () => {}, onStatus: () => () => {}, dispose: () => {}
  };
}

function isolatedSession() {
  return {
    id: SESSION_ID,
    version: 2,
    name: 'Experiment',
    cwd: '/managed/isolated',
    runMode: 'linux' as const,
    launch: { type: 'terminal' as const, shell: 'auto' as const },
    source: {
      kind: 'isolated-worktree' as const,
      checkoutId: CHECKOUT_ID,
      base: { oid: '0123456789012345678901234567890123456789' },
      generatedBranch: 'refs/heads/soloe/session/experiment',
      ownership: 'session' as const
    },
    createdAt: '2026-08-12T12:00:00.000Z',
    lastUsedAt: '2026-08-12T12:00:00.000Z'
  };
}
