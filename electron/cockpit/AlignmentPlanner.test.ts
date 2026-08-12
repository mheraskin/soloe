import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DevicePort } from './DevicePort.js';
import { AlignmentPlanner } from './AlignmentPlanner.js';
import { CockpitCatalogStore } from './CockpitCatalogStore.js';
import { CockpitOperationStore } from './CockpitOperationStore.js';

const COCKPIT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';
const SOURCE_CHECKOUT_ID = '66666666-6666-4666-8666-666666666666';
const TARGET_CHECKOUT_ID = '77777777-7777-4777-8777-777777777777';
const BASE_OID = '0123456789012345678901234567890123456789';
const SOURCE_OID = '1123456789012345678901234567890123456789';
const directories: string[] = [];

describe('AlignmentPlanner', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it('pushes the exact source revision before target fetch and fast-forward', async () => {
    const fixture = await createFixture();

    const plan = await fixture.planner.plan({
      kind: 'align-workspace',
      workspaceId: WORKSPACE_ID,
      sourceDeviceId: SOURCE_DEVICE_ID,
      targetDeviceId: TARGET_DEVICE_ID
    });

    expect(plan).toMatchObject({
      executable: true,
      preview: { sourceOid: SOURCE_OID, targetOid: BASE_OID, branchRef: 'refs/heads/main' },
      sourceDevicePlan: { intent: { kind: 'push-workspace-branch' } },
      targetDevicePlan: { intent: { kind: 'fetch-fast-forward-workspace-branch', targetOid: SOURCE_OID } }
    });
    const operation = await fixture.planner.execute(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );

    expect(operation.state).toBe('succeeded');
    expect(fixture.order).toEqual(['source:push-workspace-branch', 'target:fetch-fast-forward-workspace-branch']);
  });

  it('records a recoverable residue when target alignment fails after publication', async () => {
    const fixture = await createFixture({ failTarget: true });
    const plan = await fixture.planner.plan({
      kind: 'align-workspace',
      workspaceId: WORKSPACE_ID,
      sourceDeviceId: SOURCE_DEVICE_ID,
      targetDeviceId: TARGET_DEVICE_ID
    });

    await expect(fixture.planner.execute(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    )).rejects.toThrow('protected target');
    const operation = fixture.operations.listRecoverable()[0];
    expect(operation).toMatchObject({
      kind: 'align-workspace',
      state: 'needs-attention',
      phase: 'target-failed'
    });
    expect(fixture.order).toEqual(['source:push-workspace-branch', 'target:fetch-fast-forward-workspace-branch']);
  });
});

async function createFixture(options: { failTarget?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-alignment-planner-'));
  directories.push(directory);
  const catalog = new CockpitCatalogStore(path.join(directory, 'catalog.json'));
  const operations = new CockpitOperationStore(path.join(directory, 'operations.json'));
  await Promise.all([catalog.init(), operations.init()]);
  await catalog.execute({
    expectedRevision: 0,
    mutations: [
      {
        type: 'project.create',
        project: { id: PROJECT_ID, name: 'Compiler', canonicalRepository: null }
      },
      {
        type: 'workspace.create',
        workspace: {
          id: WORKSPACE_ID,
          projectId: PROJECT_ID,
          name: 'main',
          source: {
            kind: 'branch',
            localRef: 'refs/heads/main',
            lastResolved: { oid: SOURCE_OID, observedAt: '2026-08-12T12:00:00.000Z' }
          }
        }
      },
      {
        type: 'location.link',
        location: {
          id: '88888888-8888-4888-8888-888888888888',
          workspaceId: WORKSPACE_ID,
          checkout: { deviceId: SOURCE_DEVICE_ID, checkoutId: SOURCE_CHECKOUT_ID },
          state: 'available'
        }
      },
      {
        type: 'location.link',
        location: {
          id: '99999999-9999-4999-8999-999999999999',
          workspaceId: WORKSPACE_ID,
          checkout: { deviceId: TARGET_DEVICE_ID, checkoutId: TARGET_CHECKOUT_ID },
          state: 'available'
        }
      }
    ]
  });
  const order: string[] = [];
  const source = alignmentDevice('source', SOURCE_DEVICE_ID, SOURCE_CHECKOUT_ID, SOURCE_OID, order);
  const target = alignmentDevice(
    'target',
    TARGET_DEVICE_ID,
    TARGET_CHECKOUT_ID,
    BASE_OID,
    order,
    options.failTarget
  );
  const planner = new AlignmentPlanner({
    cockpitId: COCKPIT_ID,
    catalog,
    operations,
    getDevice: (deviceId) => deviceId === SOURCE_DEVICE_ID
      ? source
      : deviceId === TARGET_DEVICE_ID ? target : null,
    now: () => new Date('2026-08-12T12:00:00.000Z')
  });
  return { planner, operations, order };
}

function alignmentDevice(
  label: string,
  deviceId: string,
  checkoutId: string,
  headOid: string,
  order: string[],
  fail = false
): DevicePort {
  const descriptor = {
    schemaVersion: 1 as const,
    deviceId,
    name: `${label} Device`,
    platform: 'linux' as const,
    serverEpoch: `${deviceId.slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    service: { name: 'soloe-server' as const, version: '0.1.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: { revision: 'alignment-v1', features: ['workspace-alignment-plan.v1'] }
  };
  const workspacePlan = vi.fn(async (intent: any) => ({
    schemaVersion: 1 as const,
    planId: label === 'source'
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    planToken: `${label}.token`,
    targetDeviceId: deviceId,
    capabilityRevision: 'alignment-v1',
    expectedWorkspaceRevision: 1,
    expectedCheckoutVersion: 1,
    intent: intent.kind === 'push-workspace-branch'
      ? { ...intent, expectedLocalOid: headOid, expectedRemoteOid: BASE_OID }
      : { ...intent, expectedHeadOid: headOid, expectedRemoteOid: SOURCE_OID },
    executable: true,
    blockers: [],
    warnings: [`${label} warning`],
    preview: { repositoryPath: `/${label}`, targetPath: `/${label}`, sourceLabel: 'refs/heads/main' },
    remoteEvidence: {
      remote: 'origin',
      remoteUrl: 'ssh://git@example.test/compiler.git',
      branchRef: 'refs/heads/main',
      localOid: headOid,
      remoteOid: BASE_OID,
      observedAt: '2026-08-12T12:00:00.000Z'
    },
    createdAt: '2026-08-12T12:00:00.000Z',
    expiresAt: '2026-08-12T12:05:00.000Z'
  }));
  return {
    deviceId,
    status: { deviceId, state: 'ready', descriptor },
    connect: async () => ({ deviceId, state: 'ready', descriptor }),
    snapshot: async () => ({
      descriptor,
      workspace: {
        schemaVersion: 1,
        revision: 1,
        deviceId,
        repositories: [],
        checkouts: [{
          id: checkoutId,
          repositoryId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          path: `/${label}`,
          runMode: 'linux',
          role: 'workspace',
          lifecycle: 'ready',
          version: 1,
          createdAt: '2026-08-12T12:00:00.000Z',
          updatedAt: '2026-08-12T12:00:00.000Z'
        }]
      },
      sessions: [], archivedSessions: [], runtimes: [], capturedAt: '2026-08-12T12:00:00.000Z'
    }),
    workspacePlan,
    workspaceExecute: vi.fn(async (command) => {
      order.push(`${label}:${command.intent.kind}`);
      if (fail) throw new Error('protected target');
      return {
        schemaVersion: 1 as const,
        cockpitId: command.cockpitId,
        commandId: command.commandId,
        targetDeviceId: deviceId,
        kind: command.intent.kind,
        intentDigest: 'digest',
        state: 'succeeded' as const,
        createdAt: '2026-08-12T12:00:00.000Z',
        updatedAt: '2026-08-12T12:00:00.000Z',
        result: {}
      };
    }),
    setTerminalOutputDemand: async () => {}, terminalInput: async () => {},
    terminalResize: async () => {}, terminalReplay: async (terminalId) => ({
      terminalRef: { deviceId, terminalId }, sessionRef: null, snapshot: null
    }), terminalStop: async () => {}, onEvent: () => () => {}, onStatus: () => () => {}, dispose: () => {}
  };
}
