import { describe, expect, it } from 'vitest';

import type { CockpitCatalogSnapshot } from '@shared/types/workspaces.js';
import type { CockpitDeviceSummary, CockpitSessionProjection } from '@shared/types/cockpit.js';
import { ProjectionEngine } from './ProjectionEngine.js';

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const LOCATION_ID = '55555555-5555-4555-8555-555555555555';
const CHECKOUT_A = '66666666-6666-4666-8666-666666666666';

describe('ProjectionEngine', () => {
  it('joins composite Session references and keeps unmatched Devices in recovery groups', () => {
    const projected = new ProjectionEngine().project({
      catalog: catalog(),
      devices: [device(DEVICE_A, 'Alpha', 'ready'), device(DEVICE_B, 'Beta', 'offline')],
      sessions: [session(DEVICE_A), session(DEVICE_B)],
      deviceWorkspaces: new Map([
        [DEVICE_A, {
          schemaVersion: 1,
          revision: 1,
          deviceId: DEVICE_A,
          repositories: [],
          checkouts: [{
            id: CHECKOUT_A,
            repositoryId: '77777777-7777-4777-8777-777777777777',
            path: '/repo',
            runMode: 'linux',
            role: 'main',
            lifecycle: 'ready',
            version: 1,
            createdAt: '2026-08-12T12:00:00.000Z',
            updatedAt: '2026-08-12T12:00:00.000Z'
          }]
        }]
      ])
    });

    expect(projected.projects[0]?.workspaces[0]?.sessions).toEqual([
      expect.objectContaining({
        projection: expect.objectContaining({ ref: { deviceId: DEVICE_A, sessionId: 'same' } }),
        sourceConformance: 'aligned'
      })
    ]);
    expect(projected.unassigned).toEqual([
      expect.objectContaining({
        device: expect.objectContaining({ deviceId: DEVICE_B, state: 'offline' }),
        sessions: [expect.objectContaining({ ref: { deviceId: DEVICE_B, sessionId: 'same' } })]
      })
    ]);
  });

  it('keeps logical Projects and Workspaces visible when all Devices are offline', () => {
    const projected = new ProjectionEngine().project({
      catalog: catalog(),
      devices: [device(DEVICE_A, 'Alpha', 'offline')],
      sessions: [],
      deviceWorkspaces: new Map()
    });

    expect(projected.projects).toEqual([
      expect.objectContaining({
        project: expect.objectContaining({ id: PROJECT_ID }),
        workspaces: [expect.objectContaining({
          workspace: expect.objectContaining({ id: WORKSPACE_ID }),
          locations: [expect.objectContaining({ availability: 'offline', checkout: null })]
        })]
      })
    ]);
  });
});

function catalog(): CockpitCatalogSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    projects: [{
      id: PROJECT_ID,
      version: 1,
      name: 'Compiler',
      canonicalRepository: null,
      repositoryAliases: [],
      order: 0,
      createdAt: '2026-08-12T12:00:00.000Z',
      updatedAt: '2026-08-12T12:00:00.000Z'
    }],
    projectPresences: [],
    workspaces: [{
      id: WORKSPACE_ID,
      projectId: PROJECT_ID,
      version: 1,
      name: 'main',
      source: { kind: 'branch', localRef: 'refs/heads/main' },
      order: 0,
      createdAt: '2026-08-12T12:00:00.000Z',
      updatedAt: '2026-08-12T12:00:00.000Z'
    }],
    workspaceLocations: [{
      id: LOCATION_ID,
      workspaceId: WORKSPACE_ID,
      checkout: { deviceId: DEVICE_A, checkoutId: CHECKOUT_A },
      desiredRole: 'ordinary',
      state: 'available',
      version: 1,
      linkedAt: '2026-08-12T12:00:00.000Z'
    }],
    sessionMemberships: [{
      sessionRef: { deviceId: DEVICE_A, sessionId: 'same' },
      workspaceId: WORKSPACE_ID,
      order: 0,
      linkedAt: '2026-08-12T12:00:00.000Z'
    }],
    migrations: []
  };
}

function device(
  deviceId: string,
  name: string,
  state: CockpitDeviceSummary['state']
): CockpitDeviceSummary {
  return { deviceId, name, state };
}

function session(deviceId: string): CockpitSessionProjection {
  return {
    ref: { deviceId, sessionId: 'same' },
    key: `${deviceId}/same`,
    deviceName: deviceId === DEVICE_A ? 'Alpha' : 'Beta',
    session: {
      id: 'same',
      version: 2,
      source: {
        kind: 'existing-checkout',
        checkoutId: deviceId === DEVICE_A ? CHECKOUT_A : '88888888-8888-4888-8888-888888888888',
        adopted: true
      },
      name: 'Shell',
      cwd: '/repo',
      runMode: 'linux',
      launch: { type: 'terminal', shell: 'auto' },
      createdAt: '2026-08-12T12:00:00.000Z',
      lastUsedAt: '2026-08-12T12:00:00.000Z'
    },
    runtime: null
  };
}
