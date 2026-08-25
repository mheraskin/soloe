import { describe, expect, it, vi } from 'vitest';

import type { DeviceDescriptor } from '@shared/types/devices.js';
import { RemoteSessionDevice } from './RemoteSessionDevice.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const FIRST_EPOCH = '22222222-2222-4222-8222-222222222222';
const SECOND_EPOCH = '33333333-3333-4333-8333-333333333333';

describe('RemoteSessionDevice', () => {
  it('publishes semantic agent observations from the owning remote Device', async () => {
    const observation = {
      id: 'session-1',
      sessionId: 'session-1',
      runtimeMode: 'tui',
      subjectKind: 'session',
      provider: 'codex',
      state: 'idle'
    };
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
        return jsonResponse({
          ok: true,
          value: request.namespace === 'observer' ? [observation] : []
        });
      },
      socketFactory: () => new FakeSocket()
    });

    await expect(client.readInventory()).resolves.toMatchObject({ observations: [observation] });
    client.dispose();
  });

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

  it('uploads clipboard images through the owning remote Device file service', async () => {
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
        return jsonResponse({
          ok: true,
          value: { paths: [], insertedText: '\x16' }
        });
      },
      socketFactory: () => new FakeSocket()
    });
    const request = {
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      images: [{ mimeType: 'image/png', dataBase64: 'cG5n' }],
      control: {
        sessionId: 'session-1',
        ownerDeviceId: DEVICE_ID,
        controllerDeviceId: 'controller-device',
        leaseId: 'lease-1'
      }
    };

    await expect(client.pasteImagesIntoTerminal(request)).resolves.toEqual({
      paths: [],
      insertedText: '\x16'
    });
    expect(calls).toEqual([expect.objectContaining({
      namespace: 'files',
      method: 'pasteImagesIntoTerminal',
      args: [request]
    })]);
    client.dispose();
  });

  it('asks the owning remote Device to expose a localhost port through Tailscale', async () => {
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
        return jsonResponse({
          ok: true,
          value: {
            deviceId: DEVICE_ID,
            state: 'ready',
            dnsName: 'alpha.tailnet.ts.net',
            port: 3000,
            forwarded: true
          }
        });
      },
      socketFactory: () => new FakeSocket()
    });

    await expect(client.ensureTailscalePort(3000)).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      dnsName: 'alpha.tailnet.ts.net',
      port: 3000
    });
    expect(calls).toEqual([
      expect.objectContaining({
        namespace: 'network',
        method: 'ensureTailscalePort',
        args: [3000]
      })
    ]);
    client.dispose();
  });

  it('routes Session metadata, deletion, and command preview to the owning remote Device', async () => {
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
        if (request.method === 'previewCommand') {
          return jsonResponse({ ok: true, value: { description: 'pnpm codex' } });
        }
        return jsonResponse({ ok: true, value: request.method === 'delete' ? true : {} });
      },
      socketFactory: () => new FakeSocket()
    });

    await client.updateSession('remote-session', { name: 'Remote name', color: undefined });
    await client.previewSessionCommand('remote-session');
    await client.deleteSession('remote-session');

    expect(calls).toEqual([
      expect.objectContaining({
        namespace: 'sessions',
        method: 'update',
        args: ['remote-session', { name: 'Remote name', color: null }]
      }),
      expect.objectContaining({
        namespace: 'sessions',
        method: 'previewCommand',
        args: ['remote-session']
      }),
      expect.objectContaining({
        namespace: 'sessions',
        method: 'delete',
        args: ['remote-session']
      })
    ]);
    client.dispose();
  });

  it('routes Project metadata updates and deletion to the owning remote Device', async () => {
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
        return jsonResponse({ ok: true, value: request.method === 'delete' ? true : {} });
      },
      socketFactory: () => new FakeSocket()
    });

    await client.updateProject('remote-project', {
      name: 'Remote Project',
      accentColor: undefined
    });
    await client.deleteProject('remote-project');

    expect(calls).toEqual([
      expect.objectContaining({
        namespace: 'projects',
        method: 'update',
        args: ['remote-project', { name: 'Remote Project', accentColor: null }]
      }),
      expect.objectContaining({
        namespace: 'projects',
        method: 'delete',
        args: ['remote-project']
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

  it('reasserts terminal output demand after reconnecting the event stream', async () => {
    const sockets: FakeSocket[] = [];
    const demandCalls: Array<{ terminalId: string; active: boolean }> = [];
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/device/describe') {
          return jsonResponse(descriptor(FIRST_EPOCH));
        }
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          namespace?: string;
          method?: string;
          args?: Array<{ terminalId: string; active: boolean }>;
        };
        if (request.namespace === 'terminal' && request.method === 'setOutputDemand') {
          demandCalls.push(request.args![0]!);
        }
        return jsonResponse({ ok: true, value: true });
      },
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelay: () => 0
    });

    await client.connect();
    await client.setTerminalOutputDemand(new Set(['terminal-1']));
    sockets[0]!.disconnect();

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => {
      expect(demandCalls.filter((call) => call.active)).toEqual([
        { terminalId: 'terminal-1', active: true },
        { terminalId: 'terminal-1', active: true }
      ]);
    });
    client.dispose();
  });

  it('reasserts remote Git observation and Feature subscriptions after reconnect', async () => {
    const sockets: FakeSocket[] = [];
    const calls: Array<{ namespace: string; method: string; args: unknown[] }> = [];
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/device/describe') {
          return jsonResponse(descriptor(FIRST_EPOCH));
        }
        const request = JSON.parse(String(init?.body ?? '{}')) as {
          namespace: string;
          method: string;
          args: unknown[];
        };
        calls.push(request);
        return jsonResponse({ ok: true, value: true });
      },
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelay: () => 0
    });
    const gitRequest = {
      deviceId: DEVICE_ID,
      namespace: 'git' as const,
      method: 'setObservationDemand',
      args: [{ cwd: '/repo', runMode: 'linux', active: true }]
    };
    const featureRequest = {
      deviceId: DEVICE_ID,
      namespace: 'features' as const,
      method: 'subscribe',
      args: [{ cwd: '/repo', runMode: 'linux' }]
    };

    await client.connect();
    await client.invokeWorktree(gitRequest);
    await client.invokeWorktree(featureRequest);
    sockets[0]!.disconnect();

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => {
      expect(calls.filter(({ namespace, method }) =>
        namespace === 'git' && method === 'setObservationDemand'
      )).toHaveLength(2);
      expect(calls.filter(({ namespace, method }) =>
        namespace === 'features' && method === 'subscribe'
      )).toHaveLength(2);
    });
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

  it('stays ready when the established event stream publishes transport status', async () => {
    const socket = new FakeSocket();
    const client = new RemoteSessionDevice({
      deviceId: DEVICE_ID,
      endpoint: 'https://alpha.example.test',
      fetchImpl: async () => jsonResponse(descriptor(FIRST_EPOCH)),
      socketFactory: () => socket
    });

    await expect(client.connect()).resolves.toMatchObject({ state: 'ready' });

    socket.message({
      event: 'location',
      deviceId: DEVICE_ID,
      serverEpoch: FIRST_EPOCH,
      sequence: 1,
      observedAt: new Date().toISOString(),
      payload: { terminalId: 'terminal-1', cwd: '/workspace' }
    });

    expect(client.status.state).toBe('ready');
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

  message(value: unknown): void {
    const event = { data: JSON.stringify(value) } as MessageEvent;
    for (const listener of this.listeners.get('message') ?? []) listener(event);
  }

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
