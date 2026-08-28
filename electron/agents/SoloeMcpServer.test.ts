import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitService } from '../git/GitService.js';
import type { SessionHookTraceEvent } from '@shared/types/session-debug.js';
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
    expect(JSON.stringify(tools)).toContain('cursor');

    const created = await server.handlePayload({
      tool: 'create_worker_session',
      arguments: {
        originSessionId: 'main',
        provider: 'codex',
        promptSummary: 'work'
      }
    }) as { workerId: string };
    expect(created.workerId).toContain('codex-worker');

    const cursor = await server.handlePayload({
      tool: 'create_worker_session',
      arguments: { originSessionId: 'main', provider: 'cursor', promptSummary: 'work' }
    }) as { workerId: string };
    expect(cursor.workerId).toContain('cursor-worker');

    const status = await server.handlePayload({
      tool: 'get_worker_status',
      arguments: { workerId: created.workerId }
    });
    expect(JSON.stringify(status)).toContain('sdk_worker');
  });

  it('keeps the exact Worktree Scope through Git resolution and diff transport', async () => {
    const observer = new AgentObserverManager();
    const runtime = new AgentRuntimeManager({ observer, sdkLoader: async () => fakeAdapter });
    const commit = {
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      author: 'A',
      authoredAt: '2026-01-01T00:00:00.000Z',
      subject: 'Scoped range'
    };
    const resolveCommitRefs = vi.fn()
      .mockResolvedValueOnce(['h'.repeat(40), 'a'.repeat(40)])
      .mockResolvedValueOnce(['b'.repeat(40)]);
    const getCommitsBetween = vi.fn().mockResolvedValue({ commits: [commit], truncated: false });
    const openForCommits = vi.fn().mockResolvedValue({
      ok: true,
      sessionId: 'ubuntu',
      cwd: '/repo',
      base: 'b'.repeat(40),
      head: 'h'.repeat(40),
      commitCount: 1
    });
    const target = {
      sessionId: 'ubuntu',
      scope: { cwd: '/repo', runMode: 'wsl' as const, wslDistro: 'Ubuntu' }
    };
    const server = new SoloeMcpServer({
      observer,
      runtime,
      git: { resolveCommitRefs, getCommitsBetween } as unknown as GitService,
      diffBridge: { openForCommits },
      resolveDiffTarget: vi.fn().mockResolvedValue(target)
    });

    await server.handlePayload({
      tool: 'open_diff_for_commits',
      arguments: { sessionId: 'ubuntu', commits: ['HEAD~1'] }
    });

    expect(resolveCommitRefs).toHaveBeenCalledWith(
      '/repo',
      ['HEAD', 'HEAD~1'],
      { runMode: 'wsl', wslDistro: 'Ubuntu' }
    );
    expect(getCommitsBetween).toHaveBeenCalledWith(
      '/repo',
      'b'.repeat(40),
      'h'.repeat(40),
      { runMode: 'wsl', wslDistro: 'Ubuntu' }
    );
    expect(openForCommits).toHaveBeenCalledWith(expect.objectContaining({
      target,
      commits: [commit]
    }));
    await runtime.dispose();
  });
});

describe('SoloeMcpServer — hook endpoints', () => {
  let server: SoloeMcpServer;
  let info: SoloeMcpServerInfo;
  let observer: AgentObserverManager;
  let runtime: AgentRuntimeManager;
  let captured: HookEvent[];
  let traces: SessionHookTraceEvent[];
  let hookHandler: (event: HookEvent) => void | Promise<void>;

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
    traces = [];
    hookHandler = (event) => {
      captured.push(event);
    };
    server = new SoloeMcpServer({
      observer,
      runtime,
      token: 'test-token',
      onHookEvent: (event) => hookHandler(event),
      onHookTrace: (event) => traces.push(event)
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
    expect(traces).toEqual([
      expect.objectContaining({
        kind: 'hook_rejected',
        provider: 'claude_code',
        sessionId: 'sess-1',
        reason: 'unauthorized'
      })
    ]);
  });

  it('rejects POSTs missing the X-Soloe-Session-Id header with 400', async () => {
    const res = await post(
      '/hook/claude',
      { hook_event_name: 'SessionStart' },
      { authorization: `Bearer ${info.token}` }
    );
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
    expect(traces).toEqual([
      expect.objectContaining({
        kind: 'hook_rejected',
        provider: 'claude_code',
        sessionId: null,
        reason: 'missing_session_id'
      })
    ]);
  });

  it('routes POST /hook/claude with valid auth to onHookEvent', async () => {
    const res = await post(
      '/hook/claude',
      { hook_event_name: 'SessionStart', session_id: 'claude-uuid' },
      {
        authorization: `Bearer ${info.token}`,
        'x-soloe-session-id': 'sess-1',
        'x-soloe-integration-version': '19'
      }
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toEqual({
      provider: 'claude_code',
      soloeSessionId: 'sess-1',
      payload: { hook_event_name: 'SessionStart', session_id: 'claude-uuid' }
    });
    await vi.waitFor(() => expect(traces).toHaveLength(3));
    expect(traces.map((trace) => trace.kind)).toEqual([
      'hook_received',
      'hook_dispatch_started',
      'hook_dispatch_completed'
    ]);
    expect(traces[0]).toEqual(expect.objectContaining({
      provider: 'claude_code',
      sessionId: 'sess-1',
      hookName: 'SessionStart',
      integrationVersion: '19',
      rawBody: '{"hook_event_name":"SessionStart","session_id":"claude-uuid"}',
      dispatchable: true
    }));
    expect(new Set(traces.map((trace) => trace.requestId)).size).toBe(1);
  });

  it('records malformed provider payloads before rejecting them', async () => {
    const res = await post(
      '/hook/codex',
      '{broken',
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );

    expect(res.status).toBe(400);
    expect(traces).toEqual([
      expect.objectContaining({
        kind: 'hook_rejected',
        provider: 'codex',
        sessionId: 'sess-1',
        reason: 'invalid_json',
        rawBody: '{broken'
      })
    ]);
  });

  it('records dispatcher failures against the received hook request', async () => {
    hookHandler = () => {
      throw new Error('projection exploded');
    };
    const res = await post(
      '/hook/grok',
      { hookEventName: 'PostCompact' },
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(traces.some((trace) => trace.kind === 'hook_dispatch_failed')).toBe(true);
    });
    expect(traces.at(-1)).toEqual(expect.objectContaining({
      kind: 'hook_dispatch_failed',
      provider: 'grok_build',
      sessionId: 'sess-1',
      hookName: 'PostCompact',
      error: 'projection exploded'
    }));
  });

  it('routes POST /hook/codex with valid auth to onHookEvent', async () => {
    const res = await post(
      '/hook/codex',
      { hook_event_name: 'SessionStart' },
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.provider).toBe('codex');
  });

  it('routes POST /hook/cursor with valid auth to onHookEvent', async () => {
    const res = await post(
      '/hook/cursor',
      { hook_event_name: 'SessionStart', session_id: 'cursor-chat-1' },
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toEqual({
      provider: 'cursor',
      soloeSessionId: 'sess-1',
      payload: { hook_event_name: 'SessionStart', session_id: 'cursor-chat-1' }
    });
  });

  it('routes POST /hook/opencode with valid auth to onHookEvent', async () => {
    const payload = {
      type: 'session.status',
      properties: { sessionID: 'open-session-1', status: { type: 'busy' } }
    };
    const res = await post(
      '/hook/opencode',
      payload,
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toEqual({
      provider: 'opencode',
      soloeSessionId: 'sess-1',
      payload
    });
  });

  it('routes POST /hook/grok with valid auth to onHookEvent', async () => {
    const payload = {
      hookEventName: 'session_start',
      sessionId: 'grok-session-1',
      cwd: '/repo'
    };
    const res = await post(
      '/hook/grok',
      payload,
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toEqual({
      provider: 'grok_build',
      soloeSessionId: 'sess-1',
      payload
    });
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

  it('acknowledges hooks before processing and preserves arrival order', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handled: string[] = [];
    hookHandler = async (event) => {
      const eventName = String(event.payload.hook_event_name);
      handled.push(eventName);
      if (eventName === 'First') await firstBlocked;
    };

    const first = await post(
      '/hook/claude',
      { hook_event_name: 'First' },
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(first.status).toBe(200);

    const second = await post(
      '/hook/claude',
      { hook_event_name: 'Second' },
      { authorization: `Bearer ${info.token}`, 'x-soloe-session-id': 'sess-1' }
    );
    expect(second.status).toBe(200);
    expect(handled).toEqual(['First']);

    releaseFirst();
    await vi.waitFor(() => expect(handled).toEqual(['First', 'Second']));
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
