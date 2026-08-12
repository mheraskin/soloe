import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceReadSnapshot } from '@shared/types/cockpit.js';
import type { DeviceDescriptor, DeviceEventEnvelope, DeviceId } from '@shared/types/devices.js';
import type { DevicePort, DevicePortStatus } from './DevicePort.js';
import { CockpitCatalogStore } from './CockpitCatalogStore.js';
import { CockpitOperationStore } from './CockpitOperationStore.js';
import { CommandPlanner } from './CommandPlanner.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const COCKPIT_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const REPOSITORY_ID = '55555555-5555-4555-8555-555555555555';
const MAIN_CHECKOUT_ID = '66666666-6666-4666-8666-666666666666';
const LOCATION_ID = '77777777-7777-4777-8777-777777777777';

describe('CommandPlanner', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('reuses an available Location and creates, groups, and starts a Device-owned Session', async () => {
    const fixture = await createFixture({ location: true });
    const plan = await fixture.planner.planPlacement(placementIntent());

    expect(plan).toMatchObject({
      executable: true,
      preview: {
        action: 'reuse-location',
        checkoutId: MAIN_CHECKOUT_ID,
        targetPath: '/repo'
      }
    });
    const operation = await fixture.planner.executePlacement(plan.planId, []);

    expect(operation).toMatchObject({
      state: 'succeeded',
      result: {
        sessionRef: { deviceId: DEVICE_ID },
        terminalRef: { deviceId: DEVICE_ID, terminalId: 'terminal-1' },
        started: true
      }
    });
    expect(fixture.device.workspaceExecute).not.toHaveBeenCalled();
    expect(fixture.device.createSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: plan.preview.sessionId,
      draft: expect.objectContaining({
        cwd: '/repo',
        source: { kind: 'workspace-location', checkoutId: MAIN_CHECKOUT_ID, locationCorrelation: LOCATION_ID }
      })
    }));
    expect(fixture.catalog.snapshot().sessionMemberships).toEqual([
      expect.objectContaining({
        sessionRef: { deviceId: DEVICE_ID, sessionId: plan.preview.sessionId },
        workspaceId: WORKSPACE_ID
      })
    ]);
  });

  it('prepares and links a new ordinary Location while preserving a stopped Session on start failure', async () => {
    const fixture = await createFixture({ location: false, failStart: true });
    const plan = await fixture.planner.planPlacement(placementIntent());

    expect(plan).toMatchObject({
      executable: true,
      preview: { action: 'prepare-location', targetPath: expect.stringContaining('/managed/') }
    });
    const operation = await fixture.planner.executePlacement(plan.planId, []);

    expect(fixture.device.workspaceExecute).toHaveBeenCalledTimes(1);
    expect(fixture.catalog.snapshot().workspaceLocations).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        checkout: { deviceId: DEVICE_ID, checkoutId: plan.preview.checkoutId },
        state: 'available'
      })
    ]);
    expect(operation).toMatchObject({
      state: 'needs-attention',
      result: {
        sessionRef: { deviceId: DEVICE_ID, sessionId: plan.preview.sessionId },
        terminalRef: null,
        started: false,
        startError: 'spawn failed'
      }
    });
  });

  it('prepares a Session-owned isolated source without claiming an ordinary Location', async () => {
    const fixture = await createFixture({ location: false });
    const plan = await fixture.planner.planPlacement({
      ...placementIntent(),
      sourceMode: 'isolated'
    });

    expect(plan).toMatchObject({
      executable: true,
      preview: { action: 'prepare-isolated', locationId: null },
      devicePlan: { intent: { kind: 'prepare-isolated-session-source' } }
    });
    const operation = await fixture.planner.executePlacement(plan.planId, []);

    expect(fixture.catalog.snapshot().workspaceLocations).toEqual([]);
    expect(fixture.device.createSession).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({
        source: expect.objectContaining({
          kind: 'isolated-worktree',
          checkoutId: plan.preview.checkoutId,
          ownership: 'session'
        })
      })
    }));
    expect(operation).toMatchObject({ state: 'succeeded', result: { locationId: null } });
  });

  it('clones a missing Project Presence on the target Device before creating a shared Session', async () => {
    const fixture = await createFixture({
      location: false,
      presence: false,
      canonicalRepository: true
    });

    const plan = await fixture.planner.planPlacement(placementIntent());

    expect(plan).toMatchObject({
      executable: true,
      preview: { action: 'clone-presence' },
      devicePlan: {
        intent: {
          kind: 'clone-project-presence',
          sourceUrl: 'https://example.test/compiler.git',
          branchRef: 'refs/heads/main'
        }
      }
    });
    const operation = await fixture.planner.executePlacement(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );
    const repositoryId = plan.devicePlan?.intent.kind === 'clone-project-presence'
      ? plan.devicePlan.intent.repositoryId
      : null;

    expect(operation.state).toBe('succeeded');
    expect(fixture.catalog.snapshot()).toMatchObject({
      projectPresences: [{
        projectId: PROJECT_ID,
        repository: {
          deviceId: DEVICE_ID,
          repositoryId
        }
      }],
      workspaceLocations: [{
        workspaceId: WORKSPACE_ID,
        checkout: { deviceId: DEVICE_ID, checkoutId: plan.preview.checkoutId }
      }]
    });
  });

  it('records composite provenance when placement creates a Successor Session', async () => {
    const fixture = await createFixture({ location: true });
    const origin = {
      deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    };
    const plan = await fixture.planner.planPlacement({
      ...placementIntent(),
      successorOf: origin
    });

    await fixture.planner.executePlacement(plan.planId, []);

    expect(fixture.device.createSession).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ originSessionRef: origin })
    }));
  });
});

async function createFixture(options: {
  location: boolean;
  failStart?: boolean;
  presence?: boolean;
  canonicalRepository?: boolean;
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-command-planner-'));
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
          canonicalRepository: options.canonicalRepository
            ? { kind: 'git', canonicalUrl: 'https://example.test/compiler.git' }
            : null
        }
      },
      ...(options.presence === false ? [] : [{
        type: 'presence.link',
        projectId: PROJECT_ID,
        repository: { deviceId: DEVICE_ID, repositoryId: REPOSITORY_ID },
        adoptedFromEvidence: null
      }] as const),
      {
        type: 'workspace.create',
        workspace: {
          id: WORKSPACE_ID,
          projectId: PROJECT_ID,
          name: 'main',
          source: {
            kind: 'branch',
            localRef: 'refs/heads/main',
            lastResolved: {
              oid: '0123456789012345678901234567890123456789',
              observedAt: '2026-08-12T12:00:00.000Z'
            }
          }
        }
      },
      ...(options.location ? [{
        type: 'location.link' as const,
        location: {
          id: LOCATION_ID,
          workspaceId: WORKSPACE_ID,
          checkout: { deviceId: DEVICE_ID, checkoutId: MAIN_CHECKOUT_ID },
          state: 'available' as const
        }
      }] : [])
    ]
  });
  const device = new PlacementDevice(options.failStart ?? false, options.presence !== false);
  const planner = new CommandPlanner({
    cockpitId: COCKPIT_ID,
    catalog,
    operations,
    getDevice: (deviceId) => deviceId === DEVICE_ID ? device : null,
    now: () => new Date('2026-08-12T12:00:00.000Z')
  });
  return { directory, catalog, operations, device, planner };
}

function placementIntent() {
  return {
    kind: 'place-session' as const,
    workspaceId: WORKSPACE_ID,
    targetDeviceId: DEVICE_ID,
    sourceMode: 'shared' as const,
    session: {
      name: 'Placed shell',
      launch: { type: 'terminal' as const, shell: 'auto' as const }
    }
  };
}

class PlacementDevice implements DevicePort {
  readonly deviceId = DEVICE_ID;
  readonly workspaceExecute = vi.fn(async (command) => {
    const checkoutId = command.intent.checkoutId;
    return {
      schemaVersion: 1 as const,
      cockpitId: command.cockpitId,
      commandId: command.commandId,
      targetDeviceId: DEVICE_ID,
      kind: command.intent.kind,
      intentDigest: 'digest',
      state: 'succeeded' as const,
      createdAt: '2026-08-12T12:00:00.000Z',
      updatedAt: '2026-08-12T12:00:00.000Z',
      result: {
        checkout: {
          id: checkoutId,
          repositoryId: REPOSITORY_ID,
          path: `/managed/${checkoutId}`,
          runMode: 'linux' as const,
          role: command.intent.kind === 'prepare-isolated-session-source'
            ? 'isolated-session' as const
            : 'workspace' as const,
          ...(command.intent.kind === 'prepare-isolated-session-source'
            ? { ownerSessionId: command.intent.ownerSessionId }
            : {}),
          lifecycle: 'ready' as const,
          version: 2,
          createdAt: '2026-08-12T12:00:00.000Z',
          updatedAt: '2026-08-12T12:00:00.000Z'
        },
        workspaceRevision: 2
      }
    };
  });
  readonly createSession = vi.fn(async (request) => ({
    ...request.draft,
    id: request.sessionId,
    version: 1,
    createdAt: '2026-08-12T12:00:00.000Z',
    lastUsedAt: '2026-08-12T12:00:00.000Z'
  }));
  readonly startSession = vi.fn(async (sessionId) => {
    if (this.failStart) throw new Error('spawn failed');
    return {
      terminalId: 'terminal-1',
      sessionId,
      pid: 1,
      spec: { file: 'sh', args: [], cwd: '/repo', env: {}, description: 'shell' }
    };
  });
  readonly workspacePlan = vi.fn(async (intent) => ({
    schemaVersion: 1 as const,
    planId: '88888888-8888-4888-8888-888888888888',
    planToken: '88888888-8888-4888-8888-888888888888.token',
    targetDeviceId: DEVICE_ID,
    capabilityRevision: 'workspace-v1',
    expectedWorkspaceRevision: 1,
    intent: { ...intent, path: `/managed/${intent.checkoutId}` },
    executable: true,
    blockers: [],
    warnings: [],
    preview: {
      repositoryPath: '/repo',
      targetPath: `/managed/${intent.checkoutId}`,
      sourceLabel: 'refs/heads/main'
    },
    createdAt: '2026-08-12T12:00:00.000Z',
    expiresAt: '2026-08-12T12:05:00.000Z'
  }));
  private readonly descriptor: DeviceDescriptor = {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    name: 'Build Device',
    platform: 'linux',
    serverEpoch: '99999999-9999-4999-8999-999999999999',
    service: { name: 'soloe-server', version: '0.1.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: { revision: 'workspace-v1', features: ['workspace-placement-plan.v1'] }
  };

  constructor(
    private readonly failStart: boolean,
    private readonly hasRepository: boolean
  ) {}

  get status(): DevicePortStatus {
    return { deviceId: DEVICE_ID, state: 'ready', descriptor: this.descriptor };
  }

  async connect() { return this.status; }
  async snapshot(): Promise<DeviceReadSnapshot> {
    return {
      descriptor: this.descriptor,
      workspace: {
        schemaVersion: 1,
        revision: 1,
        deviceId: DEVICE_ID,
        repositories: this.hasRepository ? [{
          id: REPOSITORY_ID,
          version: 1,
          identity: null,
          createdAt: '2026-08-12T12:00:00.000Z',
          updatedAt: '2026-08-12T12:00:00.000Z'
        }] : [],
        checkouts: this.hasRepository ? [{
          id: MAIN_CHECKOUT_ID,
          repositoryId: REPOSITORY_ID,
          path: '/repo',
          runMode: 'linux',
          role: 'main',
          lifecycle: 'ready',
          version: 1,
          createdAt: '2026-08-12T12:00:00.000Z',
          updatedAt: '2026-08-12T12:00:00.000Z'
        }] : []
      },
      sessions: [],
      archivedSessions: [],
      runtimes: [],
      capturedAt: '2026-08-12T12:00:00.000Z'
    };
  }
  async setTerminalOutputDemand() {}
  async terminalInput() {}
  async terminalResize() {}
  async terminalReplay(terminalId: string) {
    return { terminalRef: { deviceId: DEVICE_ID, terminalId }, sessionRef: null, snapshot: null };
  }
  async terminalStop() {}
  onEvent(_listener: (event: DeviceEventEnvelope) => void) { return () => {}; }
  onStatus(_listener: (status: DevicePortStatus) => void) { return () => {}; }
  dispose() {}
}
