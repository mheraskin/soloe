import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentObserverManager } from './AgentObserverManager.js';
import { AgentRuntimeManager, type WorkerSdkAdapter } from './AgentRuntimeManager.js';
import {
  isAuthorizedHeaders,
  SoloeMcpServer,
  type HookEvent,
  type SoloeMcpServerInfo
} from './SoloeMcpServer.js';

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

describe('SoloeMcpServer — hook endpoints', () => {
  let server: SoloeMcpServer;
  let info: SoloeMcpServerInfo;
  let observer: AgentObserverManager;
  let runtime: AgentRuntimeManager;
  let captured: HookEvent[];
  let hookHandler: (event: HookEvent) => void;

  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${info.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      /* ignore */
    }
    return { status: response.status, body: parsed };
  }

  beforeEach(async () => {
    observer = new AgentObserverManager();
    runtime = new AgentRuntimeManager({ observer });
    captured = [];
    hookHandler = (event) => {
      captured.push(event);
    };
    server = new SoloeMcpServer({
      observer,
      runtime,
      token: 'test-token',
      onHookEvent: (event) => hookHandler(event)
    });
    info = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await runtime.dispose();
  });

  it('rejects unauthenticated POSTs to /hook/claude with 401', async () => {
    const res = await post(
      '/hook/claude',
      { hook_event_name: 'SessionStart' },
      { 'x-soloe-session-id': 'sess-1' }
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  it('rejects POSTs missing the X-Soloe-Session-Id header with 400', async () => {
    const res = await post(
      '/hook/claude',
      { hook_event_name: 'SessionStart' },
      { authorization: `Bearer ${info.token}` }
    );
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it('routes POST /hook/claude with valid auth to onHookEvent', async () => {
    const res = await post(
      '/hook/claude',
      { hook_event_name: 'SessionStart', session_id: 'claude-uuid' },
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      provider: 'claude_code',
      soloeSessionId: 'sess-1',
      payload: { hook_event_name: 'SessionStart', session_id: 'claude-uuid' }
    });
  });

  it('routes POST /hook/codex with valid auth to onHookEvent', async () => {
    const res = await post(
      '/hook/codex',
      { hook_event_name: 'SessionStart' },
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.provider).toBe('codex');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await post(
      '/hook/unknown',
      {},
      {
        authorization: `Bearer ${info.token}`,
        'x-soloe-session-id': 'sess-1'
      }
    );
    expect(res.status).toBe(404);
  });

  it('still authorizes /mcp with the same token', async () => {
    const res = await post(
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { authorization: `Bearer ${info.token}` }
    );
    expect(res.status).toBe(200);
  });

  it('reports a 500 when the hook callback throws', async () => {
    hookHandler = () => {
      throw new Error('boom');
    };
    const res = await post(
      '/hook/claude',
      { hook_event_name: 'SessionStart' },
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(res.status).toBe(500);
  });

  it('binds to 0.0.0.0 but advertises 127.0.0.1 without a /mcp suffix', () => {
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(info.url).not.toContain('/mcp');
  });
});

describe('SoloeMcpServer — comment_resolve', () => {
  it('lists comment_resolve in tools/list', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const server = new SoloeMcpServer({ observer, runtime, token: 'secret' });
    const tools = await server.handlePayload({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(JSON.stringify(tools)).toContain('comment_resolve');
  });

  it('forwards comment_resolve to the comments bridge', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const calls: string[] = [];
    const commentsBridge = {
      async resolveComment(id: string) {
        calls.push(id);
        return { ok: true as const };
      },
      async resolveCommentsBatch() {
        return { ok: true as const };
      }
    };
    const server = new SoloeMcpServer({ observer, runtime, token: 'secret', commentsBridge });

    const result = await server.handlePayload({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'comment_resolve', arguments: { id: 'abc-123' } }
    }) as { result?: { structuredContent?: unknown } };

    expect(calls).toEqual(['abc-123']);
    expect(result.result?.structuredContent).toEqual({ ok: true });
  });

  it('errors when bridge is unavailable', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const server = new SoloeMcpServer({ observer, runtime, token: 'secret' });

    const result = await server.handlePayload({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'comment_resolve', arguments: { id: 'abc-123' } }
    }) as { error?: { message?: string } };

    expect(result.error?.message).toBe('comments bridge not available');
  });

  it('errors when id is missing', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const commentsBridge = {
      async resolveComment() {
        return { ok: true as const };
      },
      async resolveCommentsBatch() {
        return { ok: true as const };
      }
    };
    const server = new SoloeMcpServer({ observer, runtime, token: 'secret', commentsBridge });

    const result = await server.handlePayload({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'comment_resolve', arguments: {} }
    }) as { error?: { message?: string } };

    expect(result.error?.message).toBe('id is required');
  });
});

describe('SoloeMcpServer — comment_resolve_batch', () => {
  it('lists comment_resolve_batch in tools/list', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const server = new SoloeMcpServer({ observer, runtime, token: 'secret' });
    const tools = await server.handlePayload({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(JSON.stringify(tools)).toContain('comment_resolve_batch');
  });

  it('forwards comment_resolve_batch to the comments bridge', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const calls: string[][] = [];
    const commentsBridge = {
      async resolveComment() {
        return { ok: true as const };
      },
      async resolveCommentsBatch(ids: string[]) {
        calls.push(ids);
        return { ok: true as const };
      }
    };
    const server = new SoloeMcpServer({ observer, runtime, token: 'secret', commentsBridge });

    const result = await server.handlePayload({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'comment_resolve_batch', arguments: { ids: ['a', 'b', 'c'] } }
    }) as { result?: { structuredContent?: unknown } };

    expect(calls).toEqual([['a', 'b', 'c']]);
    expect(result.result?.structuredContent).toEqual({ ok: true });
  });

  it('errors when ids is not a string array', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const commentsBridge = {
      async resolveComment() {
        return { ok: true as const };
      },
      async resolveCommentsBatch() {
        return { ok: true as const };
      }
    };
    const server = new SoloeMcpServer({ observer, runtime, token: 'secret', commentsBridge });

    const result = await server.handlePayload({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'comment_resolve_batch', arguments: { ids: 'abc' } }
    }) as { error?: { message?: string } };

    expect(result.error?.message).toBe('ids must be a string array');
  });
});

const fakeAdapter: WorkerSdkAdapter = {
  async run() {
    return { resultSummary: 'done' };
  }
};
