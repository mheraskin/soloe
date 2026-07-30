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

class FakeRuntimeProcess extends EventEmitter implements RuntimeProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  killed = false;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killed = true;
    this.emit('exit', { exitCode: 0, signal: null });
  }
}

describe('Environment Runtime lifecycle', () => {
  it('keeps a running Session alive while control clients disconnect and reconnect', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = path.join(directory, 'runtime.sock');
    const process = new FakeRuntimeProcess();
    const processFactory: RuntimeProcessFactory = {
      spawn: () => process
    };
    const host = new RuntimeHost({ endpoint, processFactory });

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
    const endpoint = path.join(directory, 'runtime.sock');
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

  it('publishes ordered Terminal output to connected control clients', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = path.join(directory, 'runtime.sock');
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

  it('delivers Terminal input through the stable runtime connection', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = path.join(directory, 'runtime.sock');
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

      await client.write(started.terminalId, 'answer\n');

      expect(process.writes).toEqual(['answer\n']);
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stops a running Session only when explicitly requested', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-runtime-'));
    const endpoint = path.join(directory, 'runtime.sock');
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
    const endpoint = path.join(directory, 'runtime.sock');
    const host = new RuntimeHost({
      endpoint,
      processFactory: new NodePtyRuntimeProcessFactory()
    });

    try {
      await host.listen();
      const client = await RuntimeClient.connect(endpoint);
      const output = new Promise<string>((resolve) => {
        const onOutput = (event: { data: string }) => {
          if (!event.data.includes('echo:ready')) return;
          client.off('output', onOutput);
          resolve(event.data);
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

      await client.write(started.terminalId, 'ready\n');

      await expect(output).resolves.toContain('echo:ready');
      client.disconnect();
    } finally {
      await host.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
