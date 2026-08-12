import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeHost, resolveRuntimeEndpoint, type RuntimeProcess } from '@soloe/runtime';
import { SoloeServer } from '../../apps/server/src/SoloeServer.js';
import type { DeviceDescriptor, DeviceId } from '@shared/types/devices.js';
import type { Session } from '@shared/types/sessions.js';
import { CockpitCoordinator, type CockpitPublishedEvent } from './CockpitCoordinator.js';
import { RemoteDeviceClient } from './RemoteDeviceClient.js';

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';

describe('CockpitCoordinator multi-server integration', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  it('keeps colliding IDs isolated across real Device transports', async () => {
    const left = await startDevice(DEVICE_A, 'Left');
    const right = await startDevice(DEVICE_B, 'Right');
    const cockpit = new CockpitCoordinator({ devices: [left.client, right.client] });
    cleanups.push(() => cockpit.dispose());
    const published: CockpitPublishedEvent[] = [];
    cockpit.onEvent((event) => published.push(event));

    const snapshot = await cockpit.refreshAll();
    expect(snapshot.sessions.map((projection) => projection.ref)).toEqual([
      { deviceId: DEVICE_A, sessionId: 'same-session' },
      { deviceId: DEVICE_B, sessionId: 'same-session' }
    ]);

    await cockpit.terminalInput(
      { deviceId: DEVICE_B, terminalId: 'same-terminal' },
      'right only'
    );
    expect(left.inputs).toEqual([]);
    expect(right.inputs).toEqual([['same-terminal', 'right only']]);

    await cockpit.setDemand('window-one', {
      terminalOutput: [{ deviceId: DEVICE_A, terminalId: 'same-terminal' }]
    });
    left.server.publish('output', {
      terminalId: 'same-terminal',
      sessionId: 'same-session',
      data: 'left output',
      seq: 1
    });
    right.server.publish('output', {
      terminalId: 'same-terminal',
      sessionId: 'same-session',
      data: 'right output',
      seq: 1
    });

    await vi.waitFor(() => {
      expect(published.filter((item) => item.event.type === 'terminal.output')).toHaveLength(1);
    });
    expect(published.find((item) => item.event.type === 'terminal.output')).toMatchObject({
      event: {
        terminalRef: { deviceId: DEVICE_A, terminalId: 'same-terminal' },
        event: { data: 'left output' }
      },
      audience: new Set(['window-one'])
    });
  });

  async function startDevice(deviceId: DeviceId, name: string): Promise<{
    client: RemoteDeviceClient;
    server: SoloeServer;
    inputs: Array<[string, string]>;
  }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), `soloe-${name.toLowerCase()}-`));
    const runtimeEndpoint = resolveRuntimeEndpoint({
      dataDirectory: directory,
      userIdentity: `${name}-${process.pid}-${Date.now()}`
    });
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new DormantProcess() }
    });
    await runtime.listen();
    const inputs: Array<[string, string]> = [];
    const session = testSession();
    const server = new SoloeServer({
      runtimeEndpoint,
      host: '127.0.0.1',
      port: 0,
      token: 'integration-token',
      deviceDescriptor: descriptor(deviceId, name),
      rpcHandler: async (call) => {
        if (call.namespace === 'sessions' && call.method === 'list') return [session];
        if (call.namespace === 'sessions' && call.method === 'listArchived') return [];
        if (call.namespace === 'terminal' && call.method === 'listRunning') {
          return [{
            sessionId: 'same-session',
            terminalId: 'same-terminal',
            status: 'running'
          }];
        }
        if (call.namespace === 'terminal' && call.method === 'input') {
          inputs.push([String(call.args[0]), String(call.args[1])]);
          return true;
        }
        if (call.namespace === 'terminal' && call.method === 'setOutputDemand') return true;
        throw new Error(`Unexpected RPC ${call.namespace}.${call.method}`);
      }
    });
    const endpoint = await server.listen();
    const client = new RemoteDeviceClient({
      deviceId,
      endpoint,
      token: 'integration-token',
      fetchImpl: (input, init) => fetch(input, init),
      reconnectDelay: () => 0
    });
    cleanups.push(async () => {
      client.dispose();
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    });
    return { client, server, inputs };
  }
});

class DormantProcess extends EventEmitter implements RuntimeProcess {
  readonly pid = 4040;
  write(): void {}
  resize(): void {}
  kill(): void {
    this.emit('exit', { exitCode: 0, signal: null });
  }
}

function descriptor(deviceId: DeviceId, name: string): DeviceDescriptor {
  return {
    schemaVersion: 1,
    deviceId,
    name,
    platform: 'linux',
    serverEpoch: deviceId === DEVICE_A
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    service: { name: 'soloe-server', version: '0.1.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: {
      revision: 'phase-1',
      features: ['device.describe.v1', 'device.snapshot.v1', 'events.envelope.v1']
    }
  };
}

function testSession(): Session {
  return {
    id: 'same-session',
    name: 'Same local ID',
    cwd: '/repo',
    runMode: 'linux',
    launch: { type: 'terminal', shell: 'auto' },
    createdAt: '2026-08-12T12:00:00.000Z',
    lastUsedAt: '2026-08-12T12:00:00.000Z'
  };
}
