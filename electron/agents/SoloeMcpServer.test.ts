import { describe, expect, it } from 'vitest';
import { AgentObserverManager } from './AgentObserverManager.js';
import { AgentRuntimeManager, type WorkerSdkAdapter } from './AgentRuntimeManager.js';
import { isAuthorizedHeaders, SoloeMcpServer } from './SoloeMcpServer.js';

describe('SoloeMcpServer', () => {
  it('validates bearer and x-soloe-token auth headers', () => {
    expect(isAuthorizedHeaders({}, 'secret')).toBe(false);
    expect(isAuthorizedHeaders({ authorization: 'Bearer secret' }, 'secret')).toBe(true);
    expect(isAuthorizedHeaders({ 'x-soloe-token': 'secret' }, 'secret')).toBe(true);
    expect(isAuthorizedHeaders({ authorization: 'Bearer wrong' }, 'secret')).toBe(false);
  });

  it('exposes MCP tool listing and worker lifecycle calls', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const server = new SoloeMcpServer({ observer, runtime, token: 'secret' });

    const tools = await server.handlePayload({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    });
    expect(JSON.stringify(tools)).toContain('create_worker_session');

    const created = await server.handlePayload({
      tool: 'create_worker_session',
      arguments: {
        originSessionId: 'main',
        provider: 'codex',
        promptSummary: 'work'
      }
    }) as { workerId: string };
    expect(created.workerId).toContain('codex-worker');

    const status = await server.handlePayload({
      tool: 'get_worker_status',
      arguments: { workerId: created.workerId }
    });
    expect(JSON.stringify(status)).toContain('sdk_worker');
  });
});

const fakeAdapter: WorkerSdkAdapter = {
  async run() {
    return { resultSummary: 'done' };
  }
};
