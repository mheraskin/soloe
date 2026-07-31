import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeProcess,
  RuntimeProcessFactory,
  RuntimeSpawnSpec
} from '@soloe/runtime';
import {
  resolveRuntimeEndpoint,
  RuntimeClient,
  RuntimeHost
} from '@soloe/runtime';
import { SoloeServer } from './SoloeServer.js';
import { SoloeDomain } from './SoloeDomain.js';

let endpointSequence = 0;

function testRuntimeEndpoint(directory: string): string {
  endpointSequence += 1;
  return resolveRuntimeEndpoint({
    dataDirectory: directory,
    userIdentity: `test-${process.pid}-${endpointSequence}`
  });
}

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
    const runtimeEndpoint = testRuntimeEndpoint(directory);
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
    const runtimeEndpoint = testRuntimeEndpoint(directory);
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
    const runtimeEndpoint = testRuntimeEndpoint(directory);
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

  it('delivers targeted events only to the owning browser client', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-targeted-'));
    const runtimeEndpoint = testRuntimeEndpoint(directory);
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new PersistentProcess() }
    });
    const server = testServer(runtimeEndpoint);
    let owner: WebSocket | undefined;
    let other: WebSocket | undefined;

    try {
      await runtime.listen();
      const baseUrl = await server.listen();
      owner = new WebSocket(
        new URL(
          '/api/runtime/events?token=test-token&clientId=overview-owner',
          baseUrl
        ).toString()
      );
      other = new WebSocket(
        new URL(
          '/api/runtime/events?token=test-token&clientId=other-client',
          baseUrl
        ).toString()
      );
      await Promise.all([opened(owner), opened(other)]);
      const ownerMessage = nextMessage(owner);
      const otherMessages: unknown[] = [];
      other.addEventListener('message', (event) => {
        otherMessages.push(JSON.parse(String(event.data)));
      });

      server.publishToClient('overview-owner', 'overview.chunk', {
        requestId: 'request-1',
        type: 'delta',
        text: 'private answer'
      });

      await expect(ownerMessage).resolves.toEqual({
        event: 'overview.chunk',
        payload: {
          requestId: 'request-1',
          type: 'delta',
          text: 'private answer'
        }
      });
      await delay(25);
      expect(otherMessages).toEqual([]);
    } finally {
      owner?.close();
      other?.close();
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps client-owned observation leases through brief WebSocket reconnects', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-clients-'));
    const runtimeEndpoint = testRuntimeEndpoint(directory);
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new PersistentProcess() }
    });
    const clientDisconnected = vi.fn();
    const clientReconnected = vi.fn();
    const server = new SoloeServer({
      runtimeEndpoint,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      clientDisconnected,
      clientReconnected,
      clientDisconnectGraceMs: 75
    });
    let first: WebSocket | undefined;
    let replacement: WebSocket | undefined;

    try {
      await runtime.listen();
      const baseUrl = await server.listen();
      const eventUrl = new URL(
        '/api/runtime/events?token=test-token&clientId=reconnecting-client',
        baseUrl
      ).toString();
      first = new WebSocket(eventUrl);
      await opened(first);
      const firstClosed = closed(first);
      first.close();
      await firstClosed;

      replacement = new WebSocket(eventUrl);
      await opened(replacement);
      await delay(100);
      expect(clientDisconnected).not.toHaveBeenCalled();
      expect(clientReconnected).toHaveBeenCalledOnce();
      expect(clientReconnected).toHaveBeenCalledWith('reconnecting-client');

      const replacementClosed = closed(replacement);
      replacement.close();
      await replacementClosed;
      await vi.waitFor(() => {
        expect(clientDisconnected).toHaveBeenCalledOnce();
        expect(clientDisconnected).toHaveBeenCalledWith('reconnecting-client');
      });
    } finally {
      first?.close();
      replacement?.close();
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects browser control without the local service token', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-auth-'));
    const runtimeEndpoint = testRuntimeEndpoint(directory);
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
    const runtimeEndpoint = testRuntimeEndpoint(directory);
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
    const runtimeEndpoint = testRuntimeEndpoint(directory);
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
    const runtimeEndpoint = testRuntimeEndpoint(directory);
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new PersistentProcess() }
    });
    const invoke = vi.fn(async () => ({ platform: 'linux' }));
    const writeLog = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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
      await request(baseUrl, '/api/rpc', {
        method: 'POST',
        body: {
          namespace: 'vault',
          method: 'save',
          args: [{
            cwd: '/repo',
            draft: {
              origin: 'https://example.test',
              username: 'ada',
              password: 'must-never-appear-in-logs'
            }
          }]
        }
      });
      const logs = writeLog.mock.calls.map(([entry]) => String(entry)).join('');
      expect(logs).toContain('"event":"rpc_start"');
      expect(logs).toContain('"event":"rpc_end"');
      expect(logs).toContain('"namespace":"system"');
      expect(logs).toContain('"method":"platform"');
      expect(logs).toContain('"durationMs":');
      expect(logs).toContain('"requestBytes":');
      expect(logs).toContain('"responseBytes":');
      expect(logs).not.toContain('test-token');
      expect(logs).not.toContain('must-never-appear-in-logs');
    } finally {
      writeLog.mockRestore();
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed and oversized RPC bodies with structured errors', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-server-rpc-validation-'));
    const runtimeEndpoint = testRuntimeEndpoint(directory);
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: { spawn: () => new PersistentProcess() }
    });
    const server = new SoloeServer({
      runtimeEndpoint,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      rpcHandler: async (call) =>
        call.method === 'oversizedResponse'
          ? 'x'.repeat(32 * 1024 * 1024)
          : true
    });

    try {
      await runtime.listen();
      const baseUrl = await server.listen();
      const malformed = await request(baseUrl, '/api/rpc', {
        method: 'POST',
        body: { namespace: 'files', method: 'readFile', args: 'not-an-array' }
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({
        error: {
          code: 'malformed_rpc_body',
          message: 'RPC body must contain a valid namespace, method, and args array'
        }
      });

      const malformedClient = await request(baseUrl, '/api/rpc', {
        method: 'POST',
        body: {
          namespace: 'files',
          method: 'readFile',
          args: [],
          clientId: '../other-client'
        }
      });
      expect(malformedClient.status).toBe(400);
      expect(await malformedClient.json()).toEqual({
        error: {
          code: 'malformed_rpc_body',
          message: 'RPC body must contain a valid namespace, method, and args array'
        }
      });

      const oversized = await fetch(new URL('/api/rpc', baseUrl), {
        method: 'POST',
        headers: {
          ...authorizationHeaders(),
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          namespace: 'files',
          method: 'writeFile',
          args: ['x'.repeat(32 * 1024 * 1024)]
        })
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({
        error: {
          code: 'request_too_large',
          message: 'JSON request exceeds the 33554432-byte limit',
          remediation: 'Send a smaller request'
        }
      });

      const oversizedResponse = await request(baseUrl, '/api/rpc', {
        method: 'POST',
        body: {
          namespace: 'system',
          method: 'oversizedResponse',
          args: []
        }
      });
      expect(oversizedResponse.status).toBe(200);
      expect(await oversizedResponse.json()).toEqual({
        ok: false,
        error: 'RPC response exceeds the 33554432-byte limit',
        code: 'response_too_large',
        remediation: 'Narrow the request or use a bounded result'
      });
    } finally {
      await server.close();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('supports browser startup, project/session creation, terminal output, and replay', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'soloe-browser-contract-'));
    const runtimeEndpoint = testRuntimeEndpoint(directory);
    const process = new PersistentProcess();
    let spawnedSpec: RuntimeSpawnSpec | undefined;
    const runtime = new RuntimeHost({
      endpoint: runtimeEndpoint,
      processFactory: {
        spawn: (options) => {
          spawnedSpec = options.spec;
          return process;
        }
      }
    });
    let domainRuntime: RuntimeClient | undefined;
    let domain: SoloeDomain | undefined;
    let server: SoloeServer | undefined;
    let firstClient: WebSocket | undefined;
    let secondClient: WebSocket | undefined;
    let claudeInstalled = false;
    const integrationStatus = () => ({
      hosts: [
        {
          host: { kind: 'linux' as const, label: 'Backend', available: true },
          claude: {
            installed: claudeInstalled,
            current: claudeInstalled,
            ...(claudeInstalled ? { version: 14 } : {})
          },
          codex: { installed: false, current: false }
        }
      ]
    });
    const integrationInstaller = {
      status: vi.fn(async () => integrationStatus()),
      installClaude: vi.fn(async () => {
        claudeInstalled = true;
      }),
      uninstallClaude: vi.fn(async () => {
        claudeInstalled = false;
      }),
      installCodex: vi.fn(),
      uninstallCodex: vi.fn()
    };
    const pathService = {
      openSessionPath: vi.fn(async () => true as const)
    };
    const fileEditorLauncher = vi.fn(async () => {});

    try {
      await runtime.listen();
      domainRuntime = await RuntimeClient.connect(runtimeEndpoint);
      domain = new SoloeDomain({
        dataDirectory: directory,
        runtime: domainRuntime,
        integrationInstaller,
        enableAgentBridge: true,
        pathService,
        fileEditorLauncher
      });
      await domain.init();
      server = new SoloeServer({
        runtimeEndpoint,
        host: '127.0.0.1',
        port: 0,
        token: 'test-token',
        rpcHandler: (call) => domain!.invoke(call)
      });
      domain.on('event', (event, payload) => server!.publish(event, payload));
      const baseUrl = await server.listen();

      await expect(rpc(baseUrl, 'sessions', 'list')).resolves.toEqual([]);
      await expect(rpc(baseUrl, 'sessions', 'listArchived')).resolves.toEqual([]);
      await expect(rpc(baseUrl, 'terminal', 'listRunning')).resolves.toEqual([]);
      await expect(rpc(baseUrl, 'observer', 'list')).resolves.toEqual([]);

      const project = await rpc<{ id: string }>(baseUrl, 'projects', 'create', [
        { name: 'Browser project', path: directory }
      ]);
      expect(await rpc(baseUrl, 'projects', 'list')).toEqual([
        expect.objectContaining({ id: project.id })
      ]);

      firstClient = new WebSocket(
        new URL(
          '/api/runtime/events?token=test-token&clientId=vault-client-one',
          baseUrl
        ).toString()
      );
      secondClient = new WebSocket(
        new URL(
          '/api/runtime/events?token=test-token&clientId=vault-client-two',
          baseUrl
        ).toString()
      );
      await Promise.all([opened(firstClient), opened(secondClient)]);
      const firstVaultChange = nextMessage(firstClient);
      const secondVaultChange = nextMessage(secondClient);
      const vaultEntry = await rpc<{ id: string }>(baseUrl, 'vault', 'save', [{
        cwd: directory,
        draft: {
          origin: 'https://example.test/login',
          username: 'browser-user',
          password: 'browser-vault-secret'
        }
      }]);
      for (const change of await Promise.all([firstVaultChange, secondVaultChange])) {
        expect(change).toEqual({
          event: 'vault.change',
          payload: expect.objectContaining({
            cwd: directory,
            entries: [
              expect.objectContaining({
                id: vaultEntry.id,
                username: 'browser-user'
              })
            ]
          })
        });
        expect(JSON.stringify(change)).not.toContain('browser-vault-secret');
      }
      await expect(rpc(baseUrl, 'vault', 'list', [{ cwd: directory }])).resolves.toEqual([
        expect.objectContaining({ id: vaultEntry.id, username: 'browser-user' })
      ]);
      await expect(
        rpc(baseUrl, 'vault', 'getSecret', [{ cwd: directory, id: vaultEntry.id }])
      ).resolves.toEqual({
        username: 'browser-user',
        password: 'browser-vault-secret'
      });

      const firstIntegrationChange = nextMessage(firstClient);
      const secondIntegrationChange = nextMessage(secondClient);
      const installedStatus = await rpc(
        baseUrl,
        'agentIntegration',
        'installClaude',
        [{ host: { kind: 'linux' } }]
      );
      expect(installedStatus).toEqual(integrationStatus());
      for (
        const change of await Promise.all([
          firstIntegrationChange,
          secondIntegrationChange
        ])
      ) {
        expect(change).toEqual({
          event: 'agentIntegration.change',
          payload: integrationStatus()
        });
        expect(JSON.stringify(change)).not.toMatch(/homeDir|homeLinux/u);
      }

      const session = await rpc<{ id: string }>(baseUrl, 'sessions', 'create', [
        {
          name: 'Browser session',
          projectId: project.id,
          cwd: directory,
          runMode: globalThis.process.platform === 'win32' ? 'windows' : 'linux',
          launch: { type: 'terminal', shell: 'auto' }
        }
      ]);
      await expect(
        rpc(baseUrl, 'system', 'openPath', [session.id])
      ).resolves.toBe(true);
      expect(pathService.openSessionPath).toHaveBeenCalledWith(session.id);
      const started = await rpc<{
        terminalId: string;
        spec: { env: Record<string, string> };
      }>(baseUrl, 'terminal', 'start', [
        { sessionId: session.id, cols: 100, rows: 30 }
      ]);
      const bridgeConfig = JSON.parse(
        await readFile(path.join(directory, 'bridge.json'), 'utf8')
      ) as { port: number; token: string };
      expect(spawnedSpec?.env).toMatchObject({
        SOLOE_SESSION_ID: session.id,
        SOLOE_BRIDGE_URL: `http://127.0.0.1:${bridgeConfig.port}`,
        SOLOE_BRIDGE_TOKEN: bridgeConfig.token
      });
      expect(started.spec.env).toMatchObject({
        SOLOE_SESSION_ID: session.id,
        SOLOE_BRIDGE_URL: `http://127.0.0.1:${bridgeConfig.port}`
      });
      expect(started.spec.env).not.toHaveProperty('SOLOE_BRIDGE_TOKEN');
      if (globalThis.process.platform !== 'win32') {
        expect((await stat(path.join(directory, 'bridge.json'))).mode & 0o777).toBe(0o600);
      }
      const hookResponse = await fetch(
        `http://127.0.0.1:${bridgeConfig.port}/hook/codex`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bridgeConfig.token}`,
            'content-type': 'application/json',
            'x-soloe-session-id': session.id
          },
          body: JSON.stringify({
            hook_event_name: 'SessionStart',
            session_id: 'codex-thread-1'
          })
        }
      );
      expect(hookResponse.status).toBe(200);
      await expect(rpc(baseUrl, 'sessions', 'get', [session.id])).resolves.toEqual(
        expect.objectContaining({
          currentAgentRuntime: expect.objectContaining({
            provider: 'codex',
            providerThreadId: 'codex-thread-1',
            status: 'active'
          })
        })
      );
      process.emit('data', 'browser contract output');

      expect(await rpc(baseUrl, 'terminal', 'replay', [started.terminalId, 0])).toEqual(
        expect.objectContaining({
          data: 'browser contract output',
          fromSeq: 1,
          toSeq: 1
        })
      );
      expect(await rpc(baseUrl, 'observer', 'list')).toEqual([
        expect.objectContaining({
          id: session.id,
          state: 'starting',
          provider: 'codex',
          providerThreadId: 'codex-thread-1'
        })
      ]);

      await expect(rpc(baseUrl, 'files', 'writeFile', [{
        cwd: directory,
        relativePath: 'browser-file.txt',
        content: 'server-backed file\n',
        runMode: globalThis.process.platform === 'win32' ? 'windows' : 'linux'
      }])).resolves.toBe(true);
      await expect(rpc(baseUrl, 'files', 'listTree', [{
        cwd: directory,
        runMode: globalThis.process.platform === 'win32' ? 'windows' : 'linux',
        force: true
      }])).resolves.toEqual(expect.objectContaining({
        cwd: directory,
        paths: expect.arrayContaining(['browser-file.txt'])
      }));
      await expect(rpc(baseUrl, 'files', 'readFile', [{
        cwd: directory,
        relativePath: 'browser-file.txt',
        runMode: globalThis.process.platform === 'win32' ? 'windows' : 'linux'
      }])).resolves.toEqual(expect.objectContaining({
        content: 'server-backed file\n',
        binary: false,
        truncated: false,
        unavailable: false
      }));
      await expect(rpc(baseUrl, 'files', 'openInEditor', [{
        cwd: directory,
        runMode: globalThis.process.platform === 'win32' ? 'windows' : 'linux',
        absolutePath: path.join(directory, 'browser-file.txt')
      }])).resolves.toBe(true);
      expect(fileEditorLauncher).toHaveBeenCalledWith(
        expect.any(String),
        await realpath(path.join(directory, 'browser-file.txt'))
      );
      await expect(rpc(baseUrl, 'files', 'search', [{
        cwd: directory,
        query: 'browser-file',
        limit: 10,
        runMode: globalThis.process.platform === 'win32' ? 'windows' : 'linux'
      }])).resolves.toEqual([
        expect.objectContaining({ path: 'browser-file.txt' })
      ]);

      const unsupported = await request(baseUrl, '/api/rpc', {
        method: 'POST',
        body: { namespace: 'browser', method: 'openDevTools', args: [] }
      });
      expect(await unsupported.json()).toEqual({
        ok: false,
        error: 'RPC browser.openDevTools is not supported by the application server',
        code: 'rpc_not_supported'
      });
    } finally {
      firstClient?.close();
      secondClient?.close();
      await server?.close();
      await domain?.dispose();
      domainRuntime?.disconnect();
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function rpc<T = unknown>(
  baseUrl: string,
  namespace: string,
  method: string,
  args: unknown[] = []
): Promise<T> {
  const response = await request(baseUrl, '/api/rpc', {
    method: 'POST',
    body: { namespace, method, args }
  });
  const result = await response.json() as
    | { ok: true; value: T }
    | { ok: false; error: string; code?: string };
  if (!result.ok) throw new Error(`${result.code ?? 'rpc_failed'}: ${result.error}`);
  return result.value;
}

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

async function closed(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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
