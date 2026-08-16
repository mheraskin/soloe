import { describe, expect, it, vi } from 'vitest';

import type { DeviceDescriptor } from '@shared/types/devices.js';
import { LocalSessionDevice } from './LocalSessionDevice.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

describe('LocalSessionDevice', () => {
  it('publishes semantic agent observations with its Session inventory', async () => {
    const observation = {
      id: 'session-1',
      sessionId: 'session-1',
      runtimeMode: 'tui' as const,
      subjectKind: 'session' as const,
      provider: 'codex' as const,
      state: 'idle' as const
    };
    const client = new LocalSessionDevice({
      descriptor: descriptor(),
      sessions: { list: vi.fn(async () => []), listArchived: vi.fn(async () => []) } as never,
      pty: { listRunning: () => [], on: vi.fn(), off: vi.fn() } as never,
      observer: { listSnapshots: () => [observation] }
    });

    await expect(client.readInventory()).resolves.toMatchObject({
      observations: [observation]
    });
  });

  it('reconciles legacy records before publishing a Device snapshot', async () => {
    const session = {
      id: 'later',
      version: 1,
      name: 'Later',
      cwd: '/repo-later',
      runMode: 'linux' as const,
      launch: { type: 'terminal' as const, shell: 'auto' as const },
      createdAt: '2026-08-12T12:00:00.000Z',
      lastUsedAt: '2026-08-12T12:00:00.000Z'
    };
    const source = {
      kind: 'existing-checkout' as const,
      checkoutId: '22222222-2222-4222-8222-222222222222',
      adopted: true
    };
    const sessions = {
      list: vi.fn(async () => [session]),
      listArchived: vi.fn(async () => []),
      get: vi.fn(async () => session),
      bindSource: vi.fn(async () => ({ ...session, version: 2, source }))
    };
    const projects = { list: vi.fn(async () => []) };
    const workspaceDevice = {
      reconcileLegacy: vi.fn(async () => ({
        snapshot: deviceWorkspace(),
        projectRepositories: {},
        sessionSources: [{ sessionId: session.id, source }]
      })),
      snapshot: vi.fn(() => deviceWorkspace())
    };
    const client = new LocalSessionDevice({
      descriptor: descriptor(),
      sessions: sessions as never,
      projects: projects as never,
      workspaceDevice: workspaceDevice as never,
      pty: {
        listRunning: () => [],
        on: vi.fn(),
        off: vi.fn()
      } as never
    });

    await client.snapshot();

    expect(workspaceDevice.reconcileLegacy).toHaveBeenCalledWith({
      projects: [],
      sessions: [session]
    });
    expect(sessions.bindSource).toHaveBeenCalledWith(session.id, source, 1);
  });

  it('creates and starts a preallocated Session through the owning Device adapter', async () => {
    const draft = {
      name: 'Placed',
      cwd: '/managed/checkout',
      runMode: 'linux' as const,
      launch: { type: 'terminal' as const, shell: 'auto' as const },
      source: {
        kind: 'workspace-location' as const,
        checkoutId: '22222222-2222-4222-8222-222222222222'
      }
    };
    const session = {
      ...draft,
      id: '44444444-4444-4444-8444-444444444444',
      version: 1,
      createdAt: '2026-08-12T12:00:00.000Z',
      lastUsedAt: '2026-08-12T12:00:00.000Z'
    };
    const sessions = {
      createWithId: vi.fn(async () => session),
      list: vi.fn(async () => []),
      listArchived: vi.fn(async () => [])
    };
    const pty = {
      start: vi.fn(async () => ({
        terminalId: 'terminal-1',
        sessionId: session.id,
        pid: 1,
        spec: { file: 'sh', args: [], cwd: draft.cwd, env: {}, description: 'shell' }
      })),
      listRunning: () => [],
      on: vi.fn(),
      off: vi.fn()
    };
    const client = new LocalSessionDevice({
      descriptor: descriptor(),
      sessions: sessions as never,
      pty: pty as never
    });

    await expect(client.createSession({ sessionId: session.id, draft })).resolves.toEqual(session);
    await expect(client.startSession(session.id)).resolves.toMatchObject({ terminalId: 'terminal-1' });
    expect(sessions.createWithId).toHaveBeenCalledWith(session.id, draft);
    expect(pty.start).toHaveBeenCalledWith({ sessionId: session.id });
  });

  it('exposes a localhost port through the local Device Tailscale manager', async () => {
    const ensure = vi.fn(async (port: number) => ({
      state: 'ready' as const,
      message: null,
      setupUrl: null,
      dnsName: 'local.tailnet.ts.net',
      port,
      forwarded: true
    }));
    const client = new LocalSessionDevice({
      descriptor: descriptor(),
      sessions: { list: vi.fn(async () => []), listArchived: vi.fn(async () => []) } as never,
      pty: { listRunning: () => [], on: vi.fn(), off: vi.fn() } as never,
      tailscalePorts: { ensure }
    });

    await expect(client.ensureTailscalePort(3000)).resolves.toEqual({
      deviceId: DEVICE_ID,
      state: 'ready',
      message: null,
      setupUrl: null,
      dnsName: 'local.tailnet.ts.net',
      port: 3000,
      forwarded: true
    });
    expect(ensure).toHaveBeenCalledWith(3000);
  });
});

function descriptor(): DeviceDescriptor {
  return {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    name: 'Local',
    platform: 'linux',
    serverEpoch: '33333333-3333-4333-8333-333333333333',
    service: { name: 'soloe-server', version: '0.1.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: { revision: 'local', features: ['workspace-device.v1'] }
  };
}

function deviceWorkspace() {
  return {
    schemaVersion: 1 as const,
    revision: 1,
    deviceId: DEVICE_ID,
    repositories: [],
    checkouts: []
  };
}
