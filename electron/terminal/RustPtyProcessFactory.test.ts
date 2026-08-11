import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalSidecarRequest } from '@shared/types/terminal-sidecar.js';
import { RustPtyProcessFactory, type SidecarSpawn } from './RustPtyProcessFactory.js';

class FakeSidecar extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: TerminalSidecarRequest[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    let input = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      input += chunk;
      for (;;) {
        const newline = input.indexOf('\n');
        if (newline < 0) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        const request = JSON.parse(line) as TerminalSidecarRequest;
        this.sent.push(request);
        this.respond(request);
      }
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    return true;
  }

  emitMessage(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private respond(request: TerminalSidecarRequest): void {
    if (request.method === 'ping') {
      this.emitMessage({ id: request.id, ok: true, value: { protocolVersion: 1 } });
      return;
    }
    if (request.method === 'start') {
      const params = request.params as { terminalId: string; sessionId: string };
      this.emitMessage({
        id: request.id,
        ok: true,
        value: { terminalId: params.terminalId, sessionId: params.sessionId, pid: 4242 }
      });
      return;
    }
    this.emitMessage({ id: request.id, ok: true, value: true });
    if (request.method === 'shutdown') {
      setTimeout(() => {
        this.exitCode = 0;
        this.emit('exit', 0, null);
      }, 0);
    }
  }
}

function spawnHarness() {
  const child = new FakeSidecar();
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams) as SidecarSpawn;
  return { child, spawn };
}

describe('RustPtyProcessFactory', () => {
  it('negotiates the protocol and preserves UTF-8 across output batches', async () => {
    const { child, spawn } = spawnHarness();
    const factory = new RustPtyProcessFactory({ executablePath: '/fake/sidecar', spawn });
    const process = await factory.spawn({
      terminalId: 't-1',
      sessionId: 's-1',
      spec: { file: '/bin/bash', args: [], cwd: '/tmp', env: {}, description: 'bash' },
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color' }
    });
    const data: string[] = [];
    const exits: unknown[] = [];
    process.onData((value) => data.push(value));
    process.onExit((value) => exits.push(value));

    const emoji = Buffer.from('😀');
    child.emitMessage({
      event: 'output',
      payload: { terminalId: 't-1', sessionId: 's-1', dataBase64: emoji.subarray(0, 2).toString('base64'), seq: 1 }
    });
    child.emitMessage({
      event: 'output',
      payload: { terminalId: 't-1', sessionId: 's-1', dataBase64: emoji.subarray(2).toString('base64'), seq: 2 }
    });
    child.emitMessage({
      event: 'exit',
      payload: { terminalId: 't-1', sessionId: 's-1', exitCode: 0, signalName: null }
    });

    await vi.waitFor(() => expect(data).toEqual(['😀']));
    expect(exits).toEqual([{ exitCode: 0 }]);
    expect(process.pid).toBe(4242);
    expect(child.sent.map((request) => request.method).slice(0, 2)).toEqual(['ping', 'start']);
    await factory.dispose();
  });

  it('maps write, resize, and stop operations to bounded requests', async () => {
    const { child, spawn } = spawnHarness();
    const factory = new RustPtyProcessFactory({ executablePath: '/fake/sidecar', spawn });
    const process = await factory.spawn({
      terminalId: 't-2',
      sessionId: 's-2',
      spec: { file: '/bin/bash', args: ['-l'], cwd: '/tmp', env: {}, description: 'bash -l' },
      cols: 80,
      rows: 24,
      env: {}
    });

    process.write('λ');
    process.resize(120, 40);
    process.kill();

    await vi.waitFor(() => expect(child.sent).toHaveLength(5));
    expect(child.sent.slice(2).map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'input', params: { terminalId: 't-2', dataBase64: Buffer.from('λ').toString('base64') } },
      { method: 'resize', params: { terminalId: 't-2', cols: 120, rows: 40 } },
      { method: 'stop', params: { terminalId: 't-2' } }
    ]);
    await factory.dispose();
  });
});
