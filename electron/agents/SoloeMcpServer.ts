import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AgentRuntimeManager } from './AgentRuntimeManager.js';
import type { AgentObserverManager } from './AgentObserverManager.js';
import type { CommentsRpcResult } from '@shared/types/comments-rpc.js';

export type HookProvider = 'claude_code' | 'codex';

export interface HookEvent {
  provider: HookProvider;
  soloeSessionId: string;
  payload: Record<string, unknown>;
}

export interface CommentsBridgeLike {
  resolveComment(id: string): Promise<CommentsRpcResult>;
}

export interface SoloeMcpServerOptions {
  observer: AgentObserverManager;
  runtime: AgentRuntimeManager;
  host?: string;
  port?: number;
  token?: string;
  onHookEvent?: (event: HookEvent) => void | Promise<void>;
  commentsBridge?: CommentsBridgeLike;
}

export interface SoloeMcpServerInfo {
  url: string;
  token: string;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpTool[] = [
  {
    name: 'create_worker_session',
    description: 'Create a background SDK worker attached to a visible Soloe TUI session.',
    inputSchema: {
      type: 'object',
      required: ['originSessionId', 'provider'],
      properties: {
        originSessionId: { type: 'string' },
        provider: { type: 'string', enum: ['claude_code', 'codex'] },
        cwd: { type: 'string' },
        promptSummary: { type: 'string' }
      }
    }
  },
  {
    name: 'send_worker_prompt',
    description: 'Send a prompt to an existing background SDK worker.',
    inputSchema: {
      type: 'object',
      required: ['workerId', 'prompt'],
      properties: {
        workerId: { type: 'string' },
        prompt: { type: 'string' }
      }
    }
  },
  {
    name: 'get_worker_status',
    description: 'Read the latest state for a background SDK worker.',
    inputSchema: {
      type: 'object',
      required: ['workerId'],
      properties: { workerId: { type: 'string' } }
    }
  },
  {
    name: 'list_worker_events',
    description: 'List recent observer events for a background SDK worker.',
    inputSchema: {
      type: 'object',
      required: ['workerId'],
      properties: {
        workerId: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'stop_worker_session',
    description: 'Stop a running background SDK worker.',
    inputSchema: {
      type: 'object',
      required: ['workerId'],
      properties: { workerId: { type: 'string' } }
    }
  },
  {
    name: 'comment_resolve',
    description:
      'Mark a Soloe diff comment as resolved. The id is the value embedded in the [soloe-comment:<id>] tag at the top of the prompt that delivered the comment.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } }
    }
  }
];

export class SoloeMcpServer {
  private server: Server | null = null;
  readonly token: string;

  constructor(private readonly opts: SoloeMcpServerOptions) {
    this.token = opts.token ?? randomBytes(24).toString('hex');
  }

  async start(): Promise<SoloeMcpServerInfo> {
    if (this.server) return this.info();
    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? 0, this.opts.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return this.info();
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  info(): SoloeMcpServerInfo {
    if (!this.server) throw new Error('Soloe MCP server is not running');
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('Soloe MCP server has no TCP address');
    return {
      url: `http://127.0.0.1:${addr.port}`,
      token: this.token
    };
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 404, { error: 'not found' });
      return;
    }
    const url = req.url ?? '';
    if (url !== '/mcp' && url !== '/hook/claude' && url !== '/hook/codex') {
      writeJson(res, 404, { error: 'not found' });
      return;
    }
    if (!isAuthorized(req, this.token)) {
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (url === '/hook/claude' || url === '/hook/codex') {
      await this.handleHookRequest(req, res, url === '/hook/claude' ? 'claude_code' : 'codex');
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      writeJson(res, 400, { error: 'invalid json' });
      return;
    }
    // JSON-RPC notifications carry no `id`. Per the MCP Streamable HTTP
    // transport, the server must reply with 202 Accepted and no body —
    // returning a JSON-RPC response (even an error one) makes rmcp clients
    // tear down the channel right after `notifications/initialized`.
    if (isJsonRpcNotification(payload)) {
      res.statusCode = 202;
      res.end();
      return;
    }
    try {
      writeJson(res, 200, await this.handlePayload(payload));
    } catch (err) {
      writeJson(res, 400, { error: errorMessage(err) });
    }
  }

  private async handleHookRequest(
    req: IncomingMessage,
    res: ServerResponse,
    provider: HookProvider
  ): Promise<void> {
    const sessionHeader = req.headers['x-soloe-session-id'];
    const soloeSessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (!soloeSessionId) {
      console.log('[soloe-hook] hook rejected — missing X-Soloe-Session-Id header', { provider });
      writeJson(res, 400, { error: 'X-Soloe-Session-Id header is required' });
      return;
    }
    let payload: Record<string, unknown> = {};
    try {
      const body = await readBody(req);
      if (body) {
        const parsed: unknown = JSON.parse(body);
        if (isRecord(parsed)) payload = parsed;
      }
    } catch {
      console.log('[soloe-hook] hook rejected — invalid json', { provider, soloeSessionId });
      writeJson(res, 400, { error: 'invalid json' });
      return;
    }
    const hookEventName =
      typeof payload['hook_event_name'] === 'string' ? payload['hook_event_name'] : '(missing)';
    console.log(
      `[soloe-hook] hook arrived: provider=${provider} session=${soloeSessionId} event=${hookEventName}`
    );
    try {
      await this.opts.onHookEvent?.({ provider, soloeSessionId, payload });
      writeJson(res, 200, { ok: true });
    } catch (err) {
      writeJson(res, 500, { error: errorMessage(err) });
    }
  }

  async handlePayload(payload: unknown): Promise<unknown> {
    if (!isRecord(payload)) throw new Error('payload must be an object');
    if (payload['jsonrpc'] === '2.0') {
      return this.handleJsonRpc(payload);
    }
    const tool = stringField(payload, 'tool') ?? stringField(payload, 'name');
    const args = isRecord(payload['arguments']) ? payload['arguments'] : {};
    if (!tool) throw new Error('tool is required');
    return this.callTool(tool, args);
  }

  private async handleJsonRpc(payload: Record<PropertyKey, unknown>): Promise<unknown> {
    const method = stringField(payload, 'method');
    const id = payload['id'] ?? null;
    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'soloe', version: '0.1.0' },
            capabilities: { tools: {} }
          }
        };
      }
      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      }
      if (method === 'tools/call') {
        const params = isRecord(payload['params']) ? payload['params'] : {};
        const name = stringField(params, 'name');
        const args = isRecord(params['arguments']) ? params['arguments'] : {};
        if (!name) throw new Error('tool name is required');
        const result = await this.callTool(name, args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result
          }
        };
      }
      throw new Error(`unsupported method: ${method ?? '(missing)'}`);
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: errorMessage(err) }
      };
    }
  }

  private async callTool(name: string, args: Record<PropertyKey, unknown>): Promise<unknown> {
    switch (name) {
      case 'create_worker_session':
        return this.opts.runtime.createWorkerSession({
          originSessionId: requiredString(args, 'originSessionId'),
          provider: requiredProvider(args),
          cwd: stringField(args, 'cwd'),
          promptSummary: stringField(args, 'promptSummary')
        });
      case 'send_worker_prompt':
        return this.opts.runtime.sendWorkerPrompt({
          workerId: requiredString(args, 'workerId'),
          prompt: requiredString(args, 'prompt')
        });
      case 'get_worker_status':
        return this.opts.runtime.getWorkerStatus(requiredString(args, 'workerId'));
      case 'list_worker_events':
        return this.opts.observer.listEvents(
          requiredString(args, 'workerId'),
          numberField(args, 'limit')
        );
      case 'stop_worker_session':
        return this.opts.runtime.stopWorkerSession(requiredString(args, 'workerId'));
      case 'comment_resolve': {
        if (!this.opts.commentsBridge) {
          throw new Error('comments bridge not available');
        }
        return this.opts.commentsBridge.resolveComment(requiredString(args, 'id'));
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  return isAuthorizedHeaders(req.headers, token);
}

export function isAuthorizedHeaders(
  headers: IncomingMessage['headers'],
  token: string
): boolean {
  const authorization = headers.authorization;
  const headerToken = Array.isArray(authorization) ? authorization[0] : authorization;
  if (headerToken === `Bearer ${token}`) return true;
  const soloeToken = headers['x-soloe-token'];
  return soloeToken === token || (Array.isArray(soloeToken) && soloeToken.includes(token));
}

function isJsonRpcNotification(payload: unknown): boolean {
  return isRecord(payload) && payload['jsonrpc'] === '2.0' && payload['id'] === undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function requiredProvider(args: Record<PropertyKey, unknown>): 'claude_code' | 'codex' {
  const provider = requiredString(args, 'provider');
  if (provider !== 'claude_code' && provider !== 'codex') {
    throw new Error('provider must be claude_code or codex');
  }
  return provider;
}

function requiredString(args: Record<PropertyKey, unknown>, key: string): string {
  const value = stringField(args, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function stringField(args: Record<PropertyKey, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberField(args: Record<PropertyKey, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
