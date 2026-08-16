import { describe, expect, it, vi } from 'vitest';

import type { DeviceDescriptor } from '@shared/types/devices.js';
import { RemoteSessionDevice } from './RemoteSessionDevice.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const FIRST_EPOCH = '22222222-2222-4222-8222-222222222222';
const SECOND_EPOCH = '33333333-3333-4333-8333-333333333333';

describe('RemoteSessionDevice', () => {
  it('includes the Device-owned Repository and Checkout registry in snapshots', async () => {
    const namespaces: string[] = [];
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/device/describe') {
          return jsonResponse(descriptor(FIRST_EPOCH));
        }
        if (url.pathname === '/api/rpc') {
          const request = JSON.parse(String(init?.body ?? '{}')) as {
            namespace: string;
            method: string;
          };
          namespaces.push(`${request.namespace}.${request.method}`);
          const value = request.namespace === 'workspaceDevice'
            ? {
                schemaVersion: 1,
                revision: 2,
                deviceId: DEVICE_ID,
                repositories: [],
                checkouts: []
              }
            : [];
          return jsonResponse({ ok: true, value });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
      socketFactory: () => new FakeSocket()
    });

    await expect(client.snapshot()).resolves.toMatchObject({
      workspace: { deviceId: DEVICE_ID, revision: 2 }
    });
    expect(namespaces).toContain('workspaceDevice.snapshot');
    client.dispose();
  });

  it('uses typed Session create/start calls on the owning remote Device', async () => {
    const calls: Array<{ namespace: string; method: string; args: unknown[] }> = [];
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/device/describe') return jsonResponse(descriptor(FIRST_EPOCH));
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          namespace: string;
          method: string;
          args: unknown[];
        };
        calls.push(request);
        if (request.method === 'createPlaced') {
          return jsonResponse({ ok: true, value: { id: '44444444-4444-4444-8444-444444444444' } });
        }
        return jsonResponse({ ok: true, value: { terminalId: 'terminal-1' } });
      },
      socketFactory: () => new FakeSocket()
    });
    const request = {
      sessionId: '44444444-4444-4444-8444-444444444444',
      draft: {
        name: 'Placed',
        cwd: '/checkout',
        runMode: 'linux' as const,
        launch: { type: 'terminal' as const, shell: 'auto' as const }
      }
    };

    await client.createSession(request);
    await client.startSession(request.sessionId);

    expect(calls).toEqual([
      expect.objectContaining({ namespace: 'sessions', method: 'createPlaced', args: [request] }),
      expect.objectContaining({
        namespace: 'terminal',
        method: 'start',
        args: [{ sessionId: request.sessionId }]
      })
    ]);
    client.dispose();
  });

  it('rejects malformed repository identity returned by a remote Device', async () => {
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/device/describe') return jsonResponse(descriptor(FIRST_EPOCH));
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          namespace: string;
          method: string;
        };
        if (request.namespace === 'workspaceDevice') {
          return jsonResponse({
            ok: true,
            value: {
              schemaVersion: 1,
              revision: 1,
              deviceId: DEVICE_ID,
              repositories: [],
              checkouts: []
            }
          });
        }
        if (request.namespace === 'projects') {
          return jsonResponse({
            ok: true,
            value: request.method === 'list'
              ? [{
                  id: 'project-1',
                  name: 'Soloe',
                  path: '/work/soloe',
                  createdAt: '2026-08-13T08:00:00.000Z',
                  lastOpenedAt: '2026-08-13T09:00:00.000Z'
                }]
              : []
          });
        }
        if (request.namespace === 'git' && request.method === 'worktrees') {
          return jsonResponse({ ok: true, value: [] });
        }
        if (request.namespace === 'git' && request.method === 'remoteUrl') {
          return jsonResponse({ ok: true, value: [] });
        }
        return jsonResponse({ ok: true, value: [] });
      },
      socketFactory: () => new FakeSocket()
    });

    const inventory = await client.readInventory();

    expect(inventory.projects[0]?.repository).toBeNull();
    client.dispose();
  });

  it('routes GitHub provider status, planning, and execution to the owning Device', async () => {
    const calls: Array<{ namespace: string; method: string; args: unknown[] }> = [];
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/device/describe') return jsonResponse(descriptor(FIRST_EPOCH));
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          namespace: string;
          method: string;
          args: unknown[];
        };
        calls.push(request);
        return jsonResponse({ ok: true, value: {} });
      },
      socketFactory: () => new FakeSocket()
    });
    const intent = {
      kind: 'create-github-repository' as const,
      owner: 'soloe',
      name: 'compiler',
      visibility: 'private' as const
    };
    const command = {
      schemaVersion: 1 as const,
      clientId: '44444444-4444-4444-8444-444444444444',
      commandId: '55555555-5555-4555-8555-555555555555',
      targetDeviceId: DEVICE_ID,
      actorClientId: 'test',
      expectedEntityVersions: {},
      capabilityRevision: 'github-v1',
      planToken: 'plan.token',
      planExpiresAt: '2026-08-12T12:05:00.000Z',
      intent
    };

    await client.githubProviderStatus();
    await client.githubProviderOwners();
    await client.githubProviderPlan(intent);
    await client.githubProviderExecute(command);

    expect(calls.map(({ namespace, method }) => `${namespace}.${method}`)).toEqual([
      'githubProvider.status',
      'githubProvider.listOwners',
      'githubProvider.planCreateRepository',
      'githubProvider.execute'
    ]);
    client.dispose();
  });

  it('returns to ready with a fresh descriptor after its Device server restarts', async () => {
    let serverEpoch = FIRST_EPOCH;
    const sockets: FakeSocket[] = [];
    const statuses: string[] = [];
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/device/describe') {
          return jsonResponse(descriptor(serverEpoch));
        }
        if (url.pathname === '/api/rpc') {
          const request = JSON.parse(String(init?.body ?? '{}')) as {
            namespace?: string;
            method?: string;
          };
          const value = request.namespace === 'terminal' && request.method === 'listRunning'
            ? []
            : [];
          return jsonResponse({ ok: true, value });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelay: () => 0
    });
    client.onStatus((status) => statuses.push(status.state));

    await expect(client.connect()).resolves.toMatchObject({
      state: 'ready',
      descriptor: { serverEpoch: FIRST_EPOCH }
    });

    serverEpoch = SECOND_EPOCH;
    sockets[0]!.disconnect();

    await vi.waitFor(() => {
      expect(client.status).toMatchObject({
        state: 'ready',
        descriptor: { serverEpoch: SECOND_EPOCH }
      });
      expect(sockets).toHaveLength(2);
    });
    expect(statuses).toContain('offline');

    client.dispose();
  });

  it('retries an initially offline Device until the descriptor becomes reachable', async () => {
    let attempts = 0;
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('offline');
        return jsonResponse(descriptor(FIRST_EPOCH));
      },
      socketFactory: () => new FakeSocket(),
      reconnectDelay: () => 0
    });

    await expect(client.connect()).rejects.toThrow('offline');
    await vi.waitFor(() => {
      expect(client.status.state).toBe('ready');
      expect(attempts).toBe(2);
    });

    client.dispose();
  });

  it('keeps the established event stream when inventory refresh reconnects a ready Device', async () => {
    const sockets: CloseBeforeEstablishedSocket[] = [];
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async () => jsonResponse(descriptor(FIRST_EPOCH)),
      socketFactory: () => {
        const socket = new CloseBeforeEstablishedSocket();
        sockets.push(socket);
        return socket;
      }
    });

    await expect(client.connect()).resolves.toMatchObject({ state: 'ready' });
    await expect(Promise.all([client.connect(), client.connect()])).resolves.toEqual([
      expect.objectContaining({ state: 'ready' }),
      expect.objectContaining({ state: 'ready' })
    ]);

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closeAttempts).toBe(0);
    sockets[0]?.establish();
    client.dispose();
  });
});

class CloseBeforeEstablishedSocket {
  closeAttempts = 0;
  private established = false;

  addEventListener(): void {}

  establish(): void {
    this.established = true;
  }

  close(): void {
    this.closeAttempts += 1;
    if (!this.established) {
      throw new Error('WebSocket was closed before the connection was established');
    }
  }
}

class FakeSocket {
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(event: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {}

  disconnect(): void {
    for (const listener of this.listeners.get('close') ?? []) listener({} as Event);
  }
}

function descriptor(serverEpoch: string): DeviceDescriptor {
  return {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    name: 'Alpha',
    platform: 'linux',
    serverEpoch,
    service: { name: 'soloe-server', version: '0.1.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: {
      revision: 'phase-1',
      features: [
        'device.describe.v1',
        'device.snapshot.v1',
        'events.envelope.v1',
        'workspace-device.v1'
      ]
    }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
