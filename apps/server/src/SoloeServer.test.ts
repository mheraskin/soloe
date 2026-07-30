import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeProcess,
  RuntimeProcessFactory
} from '@soloe/runtime';
import { RuntimeClient, RuntimeHost } from '@soloe/runtime';
import { SoloeServer } from './SoloeServer.js';

class PersistentProcess extends EventEmitter implements RuntimeProcess {
  readonly pid = 8080;
  killed = false;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];

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

describe('Soloe Server lifecycle', () => {
  it('reconnects to running Sessions after the server is replaced', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-'));
    const runtimeEndpoint = path.join(directory, 'runtime.sock');
    const process = new PersistentProcess();
    const processFactory: RuntimeProcessFactory = { spawn: () => process };
    const runtime = new RuntimeHost({ endpoint: runtimeEndpoint, processFactory });
    let firstServer: SoloeServer | undefined;
    let secondServer: SoloeServer | undefined;

    try {
      await runtime.listen();
      const runtimeClient = await RuntimeClient.connect(runtimeEndpoint);
      await runtimeClient.start({
        sessionId: 'session-that-keeps-running',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 100,
        rows: 30
      });
      runtimeClient.disconnect();

      firstServer = testServer(runtimeEndpoint);
      const firstAddress = await firstServer.listen();
      expect(await sessionsAt(firstAddress)).toEqual([
        expect.objectContaining({
          sessionId: 'session-that-keeps-running',
          status: 'running'
        })
      ]);

      await firstServer.close();
      firstServer = undefined;
      expect(process.killed).toBe(false);

      secondServer = testServer(runtimeEndpoint);
      const secondAddress = await secondServer.listen();
      expect(await sessionsAt(secondAddress)).toEqual([
        expect.objectContaining({
          sessionId: 'session-that-keeps-running',
          status: 'running'
        })
      ]);
      expect(process.killed).toBe(false);
    } finally {
      await firstServer?.close();
      await secondServer?.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('exposes runtime control without owning the terminal process', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-api-'));
    const runtimeEndpoint = path.join(directory, 'runtime.sock');
    const process = new PersistentProcess();
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => process }
    });
    const server = testServer(runtimeEndpoint);

    try {
      await runtime.listen();
      const baseUrl = await server.listen();
      const startResponse = await request(baseUrl, '/api/runtime/sessions', {
        method: 'POST',
        body: {
          sessionId: 'browser-session',
          spec: {
            file: 'test-shell',
            args: [],
            cwd: directory,
            env: {}
          },
          cols: 90,
          rows: 25
        }
      });
      expect(startResponse.status).toBe(201);
      const terminal = (await startResponse.json()) as { terminalId: string };

      process.emit('data', 'output-before-replay');
      const replayResponse = await request(
        baseUrl,
        `/api/runtime/terminals/${terminal.terminalId}/replay?afterSeq=0`
      );
      expect(await replayResponse.json()).toEqual(
        expect.objectContaining({
          data: 'output-before-replay',
          fromSeq: 1,
          toSeq: 1
        })
      );

      const inputResponse = await request(
        baseUrl,
        `/api/runtime/terminals/${terminal.terminalId}/input`,
        { method: 'POST', body: { data: 'browser input' } }
      );
      expect(inputResponse.status).toBe(204);
      expect(process.writes).toEqual(['browser input']);

      const resizeResponse = await request(
        baseUrl,
        `/api/runtime/terminals/${terminal.terminalId}/resize`,
        { method: 'POST', body: { cols: 120, rows: 40 } }
      );
      expect(resizeResponse.status).toBe(204);
      expect(process.resizes).toEqual([{ cols: 120, rows: 40 }]);

      const stopResponse = await request(
        baseUrl,
        `/api/runtime/terminals/${terminal.terminalId}`,
        { method: 'DELETE' }
      );
      expect(stopResponse.status).toBe(204);
      expect(process.killed).toBe(true);
    } finally {
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('streams live runtime output to browser clients over WebSocket', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-events-'));
    const runtimeEndpoint = path.join(directory, 'runtime.sock');
    const process = new PersistentProcess();
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => process }
    });
    const runtimeClientPromise = runtime.listen().then(() => RuntimeClient.connect(runtimeEndpoint));
    const server = testServer(runtimeEndpoint);
    let socket: WebSocket | undefined;

    try {
      const runtimeClient = await runtimeClientPromise;
      const terminal = await runtimeClient.start({
        sessionId: 'live-browser-session',
        spec: {
          file: 'test-shell',
          args: [],
          cwd: directory,
          env: {}
        },
        cols: 80,
        rows: 24
      });
      runtimeClient.disconnect();

      const baseUrl = await server.listen();
      socket = new WebSocket(
        new URL('/api/runtime/events?token=test-token', baseUrl).toString()
      );
      await opened(socket);
      const message = nextMessage(socket);
      process.emit('data', 'live output');

      expect(await message).toEqual({
        event: 'output',
        payload: {
          terminalId: terminal.terminalId,
          sessionId: 'live-browser-session',
          data: 'live output',
          seq: 1
        }
      });

      const exitMessage = nextMessage(socket);
      process.emit('exit', { exitCode: 7, signal: null });
      expect(await exitMessage).toEqual({
        event: 'exit',
        payload: {
          terminalId: terminal.terminalId,
          sessionId: 'live-browser-session',
          exitCode: 7,
          signal: null
        }
      });
    } finally {
      socket?.close();
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects browser control without the local service token', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-auth-'));
    const runtimeEndpoint = path.join(directory, 'runtime.sock');
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new PersistentProcess() }
    });
    const server = testServer(runtimeEndpoint);

    try {
      await runtime.listen();
      const baseUrl = await server.listen();
      const response = await fetch(new URL('/api/runtime/sessions', baseUrl));
      expect(response.status).toBe(401);
    } finally {
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bootstraps a secure cookie and serves the built browser client', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-web-'));
    const runtimeEndpoint = path.join(directory, 'runtime.sock');
    const webRoot = path.join(directory, 'web');
    await mkdir(webRoot);
    await writeFile(path.join(webRoot, 'index.html'), '<main>Soloe browser client</main>');
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new PersistentProcess() }
    });
    const server = new SoloeServer({
      runtimeEndpoint,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webRoot
    });

    try {
      await runtime.listen();
      const baseUrl = await server.listen();
      const bootstrap = await fetch(new URL('/?token=test-token', baseUrl), {
        redirect: 'manual'
      });
      expect(bootstrap.status).toBe(302);
      expect(bootstrap.headers.get('location')).toBe('/');
      expect(bootstrap.headers.get('set-cookie')).toContain(
        'soloe_token=test-token; HttpOnly; SameSite=Strict'
      );

      const page = await fetch(new URL('/', baseUrl), {
        headers: { cookie: 'soloe_token=test-token' }
      });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Soloe browser client');
    } finally {
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns an actionable response when browser assets are missing', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-web-missing-'));
    const runtimeEndpoint = path.join(directory, 'runtime.sock');
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new PersistentProcess() }
    });
    const server = new SoloeServer({
      runtimeEndpoint,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webRoot: path.join(directory, 'missing-web-root')
    });

    try {
      await runtime.listen();
      const baseUrl = await server.listen();
      const response = await fetch(new URL('/', baseUrl), {
        headers: { cookie: 'soloe_token=test-token' }
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: 'browser_assets_missing',
          message: 'The Soloe browser application is not available',
          remediation: 'Start the Windows web client from the Soloe tray'
        }
      });
    } finally {
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('routes authenticated browser RPC calls to the server domain', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-rpc-'));
    const runtimeEndpoint = path.join(directory, 'runtime.sock');
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new PersistentProcess() }
    });
    const invoke = vi.fn(async () => ({ platform: 'linux' }));
    const server = new SoloeServer({
      runtimeEndpoint,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      rpcHandler: invoke
    });

    try {
      await runtime.listen();
      const baseUrl = await server.listen();
      const response = await request(baseUrl, '/api/rpc', {
        method: 'POST',
        body: { namespace: 'system', method: 'platform', args: [] }
      });
      expect(await response.json()).toEqual({
        ok: true,
        value: { platform: 'linux' }
      });
      expect(invoke).toHaveBeenCalledWith({
        namespace: 'system',
        method: 'platform',
        args: []
      });
    } finally {
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function sessionsAt(baseUrl: string): Promise<unknown> {
  const response = await fetch(new URL('/api/runtime/sessions', baseUrl), {
    headers: authorizationHeaders()
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function request(
  baseUrl: string,
  pathname: string,
  options: {
    method?: string;
    body?: unknown;
  } = {}
): Promise<Response> {
  return fetch(new URL(pathname, baseUrl), {
    method: options.method,
    headers: {
      ...authorizationHeaders(),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

function testServer(runtimeEndpoint: string): SoloeServer {
  return new SoloeServer({
    runtimeEndpoint,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token'
  });
}

function authorizationHeaders(): Record<string, string> {
  return { authorization: 'Bearer test-token' };
}

async function opened(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket did not open')), 500);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket failed to open'));
    });
  });
}

async function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket message timed out')), 500);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)));
      },
      { once: true }
    );
  });
}
