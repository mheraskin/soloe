import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type {
  RuntimeProcess,
  RuntimeProcessFactory
} from './RuntimeProcess.js';
import { RuntimeClient } from './RuntimeClient.js';
import { RuntimeHost } from './RuntimeHost.js';
import { NodePtyRuntimeProcessFactory } from './NodePtyRuntimeProcessFactory.js';
import { resolveRuntimeEndpoint } from './RuntimeEndpoint.js';
import { terminalControlProof } from '../../../shared/types/terminal.js';

let endpointSequence = 0;

function testRuntimeEndpoint(directory: string): string {
  endpointSequence += 1;
  return resolveRuntimeEndpoint({
    dataDirectory: directory,
    userIdentity: `test-${process.pid}-${endpointSequence}`
  });
}

class FakeRuntimeProcess extends EventEmitter implements RuntimeProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.emit('exit', { exitCode: 0, signal: null });
  }
}

describe('Environment Runtime lifecycle', () => {
  it('exposes runtime and PTY usage through the control protocol', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => new FakeRuntimeProcess() },
      usageSampler: {
        sample: async () => ({
          availability: 'available',
          cpuPercent: 2.5,
          memoryBytes: 4096,
          processCount: 2,
          components: [
            {
              kind: 'runtime',
              availability: 'available',
              cpuPercent: 1,
              memoryBytes: 2048,
              processCount: 1
            },
            {
              kind: 'agent-pty',
              availability: 'available',
              cpuPercent: 1.5,
              memoryBytes: 2048,
              processCount: 1
            }
          ],
          sampledAt: '2026-07-31T12:00:00.000Z'
        })
      }
    });

    try {
      await host.listen();
      const client = await RuntimeClient.connect(endpoint);
      await expect(client.usage()).resolves.toMatchObject({
        availability: 'available',
        processCount: 2,
        components: [
          { kind: 'runtime' },
          { kind: 'agent-pty' }
        ]
      });
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a running Session alive while control clients disconnect and reconnect', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const processFactory: RuntimeProcessFactory = {
      spawn: () => process
    };
    const host = new RuntimeHost({ endpoint, processFactory });

    try {
      await host.listen();
      const firstClient = await RuntimeClient.connect(endpoint);
      await expect(firstClient.setReplayUnbounded(true)).resolves.toBe(true);
      const started = await firstClient.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });

      firstClient.disconnect();

      const secondClient = await RuntimeClient.connect(endpoint);
      expect(await secondClient.listRunning()).toEqual([
        expect.objectContaining({
          terminalId: started.terminalId,
          sessionId: 'session-1',
          pid: 4242,
          status: 'running'
        })
      ]);
      secondClient.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('replays Terminal output produced while no control client is connected', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => process }
    });

    try {
      await host.listen();
      const firstClient = await RuntimeClient.connect(endpoint);
      const started = await firstClient.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });
      process.emit('data', 'before disconnect');
      firstClient.disconnect();
      process.emit('data', ' while disconnected');

      const secondClient = await RuntimeClient.connect(endpoint);
      expect(await secondClient.replay(started.terminalId, 0)).toEqual({
        terminalId: started.terminalId,
        sessionId: 'session-1',
        data: 'before disconnect while disconnected',
        fromSeq: 1,
        toSeq: 2,
        truncated: false,
        byteLength: 36
      });
      secondClient.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('restores a sequence-qualified headless Terminal viewport before rendering', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => process }
    });

    try {
      await host.listen();
      const client = await RuntimeClient.connect(endpoint);
      const started = await client.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });
      const lease = await client.acquireInputLease(started.terminalId, 'client-a');
      process.emit('data', '\x1b[2Jrestored viewport');
      await client.resize(started.terminalId, 90, 28, terminalControlProof(lease));

      const snapshot = await client.screenSnapshot(started.terminalId);

      expect(snapshot).toMatchObject({
        kind: 'xterm-vt-state-v1',
        terminalId: started.terminalId,
        sessionId: 'session-1',
        cols: 90,
        rows: 28,
        toSeq: 1
      });
      expect(snapshot.data).toContain('restored viewport');
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('publishes ordered Terminal output to connected control clients', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => process }
    });

    try {
      await host.listen();
      const client = await RuntimeClient.connect(endpoint);
      const started = await client.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });
      const output = new Promise((resolve) => client.once('output', resolve));

      process.emit('data', 'hello');

      await expect(output).resolves.toEqual({
        terminalId: started.terminalId,
        sessionId: 'session-1',
        data: 'hello',
        seq: 1
      });
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('publishes and retains the current Terminal cwd from shell integration output', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => process }
    });

    try {
      await host.listen();
      const client = await RuntimeClient.connect(endpoint);
      const started = await client.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });
      const location = new Promise((resolve) => client.once('location', resolve));

      process.emit('data', '\x1b');
      process.emit('data', ']7;file:///home/me/project/packages/app\x07');

      await expect(location).resolves.toEqual({
        terminalId: started.terminalId,
        sessionId: 'session-1',
        cwd: '/home/me/project/packages/app'
      });
      await expect(client.listRunning()).resolves.toEqual([
        expect.objectContaining({
          terminalId: started.terminalId,
          cwd: '/home/me/project/packages/app'
        })
      ]);
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('delivers Terminal input through the stable runtime connection', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => process }
    });

    try {
      await host.listen();
      const client = await RuntimeClient.connect(endpoint);
      const started = await client.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });

      const lease = await client.acquireInputLease(started.terminalId, 'client-a');
      await client.write(started.terminalId, 'answer\n', terminalControlProof(lease));

      expect(process.writes).toEqual(['answer\n']);
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('arbitrates terminal input across clients with visible takeover', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => process }
    });

    try {
      await host.listen();
      const firstClient = await RuntimeClient.connect(endpoint);
      const secondClient = await RuntimeClient.connect(endpoint);
      const started = await firstClient.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });
      const firstLease = await firstClient.acquireInputLease(
        started.terminalId,
        'client-a',
        false,
        { deviceId: 'device-a', deviceName: 'MacBook Pro', ownerDeviceId: 'execution-device' }
      );

      await firstClient.write(started.terminalId, 'first', terminalControlProof(firstLease));
      await expect(secondClient.write(started.terminalId, 'spectator', {
        ...terminalControlProof(firstLease),
        controllerDeviceId: 'device-b'
      })).rejects.toMatchObject({ code: 'terminal_control_lease_stale' });
      await expect(secondClient.resize(started.terminalId, 80, 24, {
        ...terminalControlProof(firstLease),
        controllerDeviceId: 'device-b'
      })).rejects.toMatchObject({ code: 'terminal_control_lease_stale' });
      await expect(
        secondClient.acquireInputLease(started.terminalId, 'client-b')
      ).rejects.toThrow(/controlled by MacBook Pro/u);

      const visibleTakeover = new Promise((resolve) =>
        firstClient.once('inputLease', resolve)
      );
      const secondLease = await secondClient.acquireInputLease(
        started.terminalId,
        'client-b',
        true,
        { deviceId: 'device-b', deviceName: 'iPad', ownerDeviceId: 'execution-device' }
      );
      await expect(visibleTakeover).resolves.toMatchObject({
        type: 'taken-over',
        terminalId: started.terminalId,
        previousControllerDeviceId: 'device-a',
        lease: { controllerDeviceId: 'device-b' }
      });
      await expect(
        firstClient.write(started.terminalId, 'stale', terminalControlProof(firstLease))
      ).rejects.toMatchObject({ code: 'terminal_control_lease_stale' });
      await expect(firstClient.resize(
        started.terminalId,
        81,
        25,
        terminalControlProof(firstLease)
      )).rejects.toMatchObject({ code: 'terminal_control_lease_stale' });
      await secondClient.write(started.terminalId, 'second', terminalControlProof(secondLease));
      const resized = await secondClient.resize(
        started.terminalId,
        90,
        28,
        terminalControlProof(secondLease)
      );

      expect(process.writes).toEqual(['first', 'second']);
      expect(process.resizes).toEqual([{ cols: 90, rows: 28 }]);
      expect(resized).toMatchObject({ cols: 90, rows: 28, generation: secondLease.generation });
      firstClient.disconnect();
      secondClient.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('parks device affinity without keeping an exclusive input lease', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => process }
    });

    try {
      await host.listen();
      const firstClient = await RuntimeClient.connect(endpoint);
      const secondClient = await RuntimeClient.connect(endpoint);
      const started = await firstClient.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });
      const firstLease = await firstClient.acquireInputLease(
        started.terminalId,
        'client-a',
        false,
        { deviceId: 'device-a', deviceName: 'MacBook Pro' }
      );

      await expect(firstClient.parkInputLease(
        started.terminalId,
        terminalControlProof(firstLease)
      )).resolves.toBe(true);
      await expect(firstClient.currentInputLease(started.terminalId)).resolves.toBeNull();

      const secondLease = await secondClient.acquireInputLease(
        started.terminalId,
        'client-b',
        false,
        { deviceId: 'device-b', deviceName: 'iPad' }
      );
      expect(secondLease.controllerDeviceId).toBe('device-b');
      firstClient.disconnect();
      secondClient.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('releases the terminal control lease when its Runtime client disconnects', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => new FakeRuntimeProcess() }
    });

    try {
      await host.listen();
      const controller = await RuntimeClient.connect(endpoint);
      const spectator = await RuntimeClient.connect(endpoint);
      const started = await controller.start({
        sessionId: 'session-1',
        spec: { file: 'test-shell', args: [], cwd: directory, env: {} },
        cols: 100,
        rows: 30
      });
      await controller.acquireInputLease(started.terminalId, 'client-a');
      const released = new Promise((resolve) => {
        const observe = (event: unknown) => {
          if ((event as { type?: string }).type !== 'released') return;
          spectator.off('inputLease', observe);
          resolve(event);
        };
        spectator.on('inputLease', observe);
      });

      controller.disconnect();

      await expect(released).resolves.toMatchObject({
        type: 'released',
        terminalId: started.terminalId,
        previousControllerDeviceId: 'client-a'
      });
      await expect(spectator.currentInputLease(started.terminalId)).resolves.toBeNull();
      spectator.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stops a running Session only when explicitly requested', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const process = new FakeRuntimeProcess();
    const host = new RuntimeHost({
      endpoint,
      processFactory: { spawn: () => process }
    });

    try {
      await host.listen();
      const client = await RuntimeClient.connect(endpoint);
      const started = await client.start({
        sessionId: 'session-1',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });

      await client.stop(started.terminalId);

      expect(process.killed).toBe(true);
      expect(await client.listRunning()).toEqual([]);
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('owns a real interactive PTY independently of the connecting client', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = testRuntimeEndpoint(directory);
    const host = new RuntimeHost({
      endpoint,
      processFactory: new NodePtyRuntimeProcessFactory()
    });

    try {
      await host.listen();
      const client = await RuntimeClient.connect(endpoint);
      const output = new Promise<string>((resolve) => {
        let received = '';
        const onOutput = (event: { data: string }) => {
          received += event.data;
          if (!received.includes('echo:ready')) return;
          client.off('output', onOutput);
          resolve(received);
        };
        client.on('output', onOutput);
      });
      const started = await client.start({
        sessionId: 'real-session',
        spec: {
          file: process.execPath,
          args: [
            '-e',
            "process.stdin.setEncoding('utf8'); process.stdin.once('data', data => { process.stdout.write(`echo:${data.trim()}`); setTimeout(() => process.exit(0), 25); });"
          ],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });

      const lease = await client.acquireInputLease(started.terminalId, 'client-a');
      await client.write(
        started.terminalId,
        process.platform === 'win32' ? 'ready\r' : 'ready\n',
        terminalControlProof(lease)
      );

      await expect(output).resolves.toContain('echo:ready');
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
