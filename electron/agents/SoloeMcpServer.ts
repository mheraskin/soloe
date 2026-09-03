import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentRuntimeManager } from './AgentRuntimeManager.js';
import type { WorkerAgentProvider } from '@shared/types/agents.js';
import type { AgentObserverManager } from './AgentObserverManager.js';
import type { CommentsRpcResult } from '@shared/types/comments-rpc.js';
import type {
  DiffRpcResult,
  DiffWorktreeTarget,
  OpenForCommitsRequest
} from '@shared/types/diff-rpc.js';
import { worktreeRuntimeContext } from '@shared/worktree-identity.js';
import type { GitService } from '../git/GitService.js';
import type {
  SessionHookProvider,
  SessionHookTraceEvent
} from '@shared/types/session-debug.js';
import { MAX_ARTIFACT_HTML_BYTES } from '../artifacts/ArtifactStore.js';

export type HookProvider = SessionHookProvider;

export interface HookEvent {
  provider: HookProvider;
  soloeSessionId: string;
  payload: Record<string, unknown>;
}

export interface CommentsBridgeLike {
  resolveComment(id: string): Promise<CommentsRpcResult>;
  resolveCommentsBatch(ids: string[]): Promise<CommentsRpcResult>;
}

export interface DiffBridgeLike {
  openForCommits(args: OpenForCommitsRequest): Promise<DiffRpcResult>;
}

export interface ArtifactMcpToolsLike {
  publish(args: Record<PropertyKey, unknown>): Promise<unknown>;
  edit(args: Record<PropertyKey, unknown>): Promise<unknown>;
  delete(args: Record<PropertyKey, unknown>): Promise<unknown>;
  list(args: Record<PropertyKey, unknown>): Promise<unknown>;
}

export interface SoloeMcpServerOptions {
  observer: AgentObserverManager;
  runtime: AgentRuntimeManager;
  host?: string;
  port?: number;
  token?: string;
  onHookEvent?: (event: HookEvent) => void | Promise<void>;
  onHookTrace?: (event: SessionHookTraceEvent) => void;
  commentsBridge?: CommentsBridgeLike;
  diffBridge?: DiffBridgeLike;
  git?: GitService;
  artifacts?: ArtifactMcpToolsLike;
  resolveDiffTarget?: (input: {
    sessionId?: string;
    cwd?: string;
  }) => Promise<DiffWorktreeTarget>;
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
    name: 'list_artifacts',
    description:
      'List lightweight metadata for the Soloe Project resolved from cwd. Call this before publishing when existing context or links matter. Soloe artifacts are permanent HTML documents; list does not return their HTML bodies.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd'],
      properties: { cwd: { type: 'string' } }
    }
  },
  {
    name: 'publish_artifact',
    description:
      'Publish a permanent HTML artifact into the Soloe Project resolved from cwd. Supply exactly one of inline html or a safe local .html path. Markdown may be source material, but published artifacts must be self-contained, visually intentional HTML with a concise meaningful description. Call list_artifacts first when links to existing context matter. A custom home can navigate with window.parent.postMessage({channel:"soloe.artifacts",action:"open",artifactId:"..."}, "*"). Publishing signals activity but does not open the Soloe UI. Set as_home to replace the generated Project home with this user-authored HTML.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd', 'title', 'description'],
      oneOf: [{ required: ['html'] }, { required: ['path'] }],
      properties: {
        cwd: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        html: { type: 'string' },
        path: { type: 'string' },
        id: { type: 'string' },
        as_home: { type: 'boolean' }
      }
    }
  },
  {
    name: 'edit_artifact',
    description:
      'Replace one existing Soloe HTML artifact while preserving its identity and creation time. Supply cwd, id, and exactly one of inline html or a safe local .html path; title and description are optional replacements. Editing the home artifact makes it user-authored, so later catalog changes preserve its HTML exactly.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd', 'id'],
      oneOf: [{ required: ['html'] }, { required: ['path'] }],
      properties: {
        cwd: { type: 'string' },
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        html: { type: 'string' },
        path: { type: 'string' }
      }
    }
  },
  {
    name: 'delete_artifact',
    description:
      'Delete an artifact from the Soloe Project resolved from cwd. Deleting a custom home restores a system-generated home; deleting an already-missing ID is idempotent.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd', 'id'],
      properties: {
        cwd: { type: 'string' },
        id: { type: 'string' }
      }
    }
  },
  {
    name: 'create_worker_session',
    description: 'Create a background SDK worker attached to a visible Soloe TUI session.',
    inputSchema: {
      type: 'object',
      required: ['originSessionId', 'provider'],
      properties: {
        originSessionId: { type: 'string' },
        provider: { type: 'string', enum: ['claude_code', 'codex', 'cursor'] },
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
  },
  {
    name: 'comment_resolve_batch',
    description:
      'Mark several Soloe diff comments as resolved in a single call. Each id is the value embedded in a [soloe-comment:<id>] tag at the top of the prompt that delivered that comment.',
    inputSchema: {
      type: 'object',
      required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1 }
      }
    }
  },
  {
    name: 'open_diff_for_commits',
    description:
      'Open the Soloe diff viewer with a set of commits selected for review. Either cwd or sessionId must be provided; sessionId is resolved against the open sessions list. The commits array may contain SHAs, short SHAs, or refs (HEAD~3, branch names); each is resolved before opening. Base is computed as the parent of the earliest commit unless overridden.',
    inputSchema: {
      type: 'object',
      required: ['commits'],
      properties: {
        commits: { type: 'array', items: { type: 'string' }, minItems: 1 },
        cwd: { type: 'string' },
        sessionId: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        focusPath: { type: 'string' },
        includeWorkingTree: { type: 'boolean' }
      }
    }
  }
];

export class SoloeMcpServer {
  private server: Server | null = null;
  private hookDispatchQueue: Promise<void> = Promise.resolve();
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
    if (
      url !== '/mcp'
      && url !== '/hook/claude'
      && url !== '/hook/codex'
      && url !== '/hook/cursor'
      && url !== '/hook/opencode'
      && url !== '/hook/grok'
    ) {
      writeJson(res, 404, { error: 'not found' });
      return;
    }
    const hookProvider = hookProviderForUrl(url);
    if (!isAuthorized(req, this.token)) {
      if (hookProvider) {
        const sessionId = requestHeader(req, 'x-soloe-session-id');
        this.trace({
          kind: 'hook_rejected',
          id: randomUUID(),
          requestId: randomUUID(),
          timestamp: new Date().toISOString(),
          provider: hookProvider,
          sessionId,
          hookName: null,
          integrationVersion: requestHeader(req, 'x-soloe-integration-version'),
          reason: 'unauthorized',
          rawBody: null
        });
      }
      writeJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (hookProvider) {
      await this.handleHookRequest(req, res, hookProvider);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req, MAX_MCP_REQUEST_BYTES));
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
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();
    const integrationVersion = requestHeader(req, 'x-soloe-integration-version');
    const soloeSessionId = requestHeader(req, 'x-soloe-session-id');
    if (!soloeSessionId) {
      this.trace({
        kind: 'hook_rejected',
        id: randomUUID(),
        requestId,
        timestamp,
        provider,
        sessionId: null,
        hookName: null,
        integrationVersion,
        reason: 'missing_session_id',
        rawBody: null
      });
      console.log('[soloe-hook] hook rejected — missing X-Soloe-Session-Id header', { provider });
      writeJson(res, 400, { error: 'X-Soloe-Session-Id header is required' });
      return;
    }
    let rawBody = '';
    let parsed: unknown = {};
    let payload: Record<string, unknown> = {};
    try {
      rawBody = await readBody(req);
      if (rawBody) {
        parsed = JSON.parse(rawBody);
        if (isRecord(parsed)) payload = parsed;
      }
    } catch {
      this.trace({
        kind: 'hook_rejected',
        id: randomUUID(),
        requestId,
        timestamp,
        provider,
        sessionId: soloeSessionId,
        hookName: null,
        integrationVersion,
        reason: 'invalid_json',
        rawBody
      });
      console.log('[soloe-hook] hook rejected — invalid json', { provider, soloeSessionId });
      writeJson(res, 400, { error: 'invalid json' });
      return;
    }
    const hookName = providerHookName(parsed);
    this.trace({
      kind: 'hook_received',
      id: randomUUID(),
      requestId,
      timestamp,
      provider,
      sessionId: soloeSessionId,
      hookName,
      integrationVersion,
      rawBody,
      payload: parsed,
      dispatchable: isRecord(parsed)
    });
    console.log(
      `[soloe-hook] hook arrived: provider=${provider} session=${soloeSessionId} event=${hookName ?? '(missing)'}`
    );
    // A hook command runs on the interactive CLI's critical path. Acknowledge
    // as soon as the local bridge owns the payload, then reduce events in
    // arrival order without making the TUI wait on persistence or UI work.
    writeJson(res, 200, { ok: true });
    const event = { provider, soloeSessionId, payload } satisfies HookEvent;
    this.hookDispatchQueue = this.hookDispatchQueue
      .then(async () => {
        this.trace({
          kind: 'hook_dispatch_started',
          id: randomUUID(),
          requestId,
          timestamp: new Date().toISOString(),
          provider,
          sessionId: soloeSessionId,
          hookName,
          integrationVersion
        });
        await this.opts.onHookEvent?.(event);
        this.trace({
          kind: 'hook_dispatch_completed',
          id: randomUUID(),
          requestId,
          timestamp: new Date().toISOString(),
          provider,
          sessionId: soloeSessionId,
          hookName,
          integrationVersion
        });
      })
      .catch((error) => {
        this.trace({
          kind: 'hook_dispatch_failed',
          id: randomUUID(),
          requestId,
          timestamp: new Date().toISOString(),
          provider,
          sessionId: soloeSessionId,
          hookName,
          integrationVersion,
          error: errorMessage(error)
        });
        console.warn('[soloe-hook] hook dispatch failed', {
          provider,
          soloeSessionId,
          hookEventName: hookName,
          error: errorMessage(error)
        });
      });
  }

  private trace(event: SessionHookTraceEvent): void {
    try {
      this.opts.onHookTrace?.(event);
    } catch (error) {
      console.warn('[soloe-hook] failed to record hook trace', errorMessage(error));
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
      case 'comment_resolve_batch': {
        if (!this.opts.commentsBridge) {
          throw new Error('comments bridge not available');
        }
        return this.opts.commentsBridge.resolveCommentsBatch(requiredStringArray(args, 'ids'));
      }
      case 'open_diff_for_commits':
        return this.openDiffForCommits(args);
      case 'list_artifacts':
        if (!this.opts.artifacts) throw new Error('artifacts are not available');
        return this.opts.artifacts.list(args);
      case 'publish_artifact':
        if (!this.opts.artifacts) throw new Error('artifacts are not available');
        return this.opts.artifacts.publish(args);
      case 'edit_artifact':
        if (!this.opts.artifacts) throw new Error('artifacts are not available');
        return this.opts.artifacts.edit(args);
      case 'delete_artifact':
        if (!this.opts.artifacts) throw new Error('artifacts are not available');
        return this.opts.artifacts.delete(args);
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  // Resolve cwd, refs, base/head, then dispatch to the renderer through the
  // diff bridge. Input `commits` follows the newest-first convention used by
  // listRecentCommits and the UI's CommitPicker — the last entry is the
  // topologically earliest commit, and base defaults to that commit's parent.
  private async openDiffForCommits(args: Record<PropertyKey, unknown>): Promise<unknown> {
    if (!this.opts.diffBridge) throw new Error('diff bridge not available');
    if (!this.opts.git) throw new Error('git service not available');
    const git = this.opts.git;
    const commitsInput = requiredStringArray(args, 'commits');
    const explicitCwd = stringField(args, 'cwd');
    const sessionId = stringField(args, 'sessionId');
    const headRef = stringField(args, 'head') ?? 'HEAD';
    const baseOverride = stringField(args, 'base');
    const focusPath = stringField(args, 'focusPath');
    const includeWorkingTree = booleanField(args, 'includeWorkingTree') ?? true;

    if (!explicitCwd && !sessionId) throw new Error('cwd or sessionId is required');
    if (!this.opts.resolveDiffTarget) throw new Error('diff target lookup not configured');
    const target = await this.opts.resolveDiffTarget({
      ...(sessionId ? { sessionId } : {}),
      ...(explicitCwd ? { cwd: explicitCwd } : {})
    });
    const { cwd } = target.scope;
    const context = worktreeRuntimeContext(target.scope);

    // Resolve every ref the caller passed plus the head reference. Order:
    // [head, ...commits, optional base].
    const refsToResolve = [headRef, ...commitsInput];
    if (baseOverride) refsToResolve.push(baseOverride);
    const resolved = await git.resolveCommitRefs(cwd, refsToResolve, context);
    const resolvedHead = resolved[0];
    if (!resolvedHead) throw new Error(`could not resolve head ref: ${headRef}`);
    const commitShas: string[] = [];
    for (let i = 0; i < commitsInput.length; i += 1) {
      const sha = resolved[i + 1];
      if (!sha) throw new Error(`could not resolve commit ref: ${commitsInput[i]}`);
      commitShas.push(sha);
    }
    let baseSha: string;
    if (baseOverride) {
      const candidate = resolved[refsToResolve.length - 1];
      if (!candidate) throw new Error(`could not resolve base ref: ${baseOverride}`);
      baseSha = candidate;
    } else {
      const earliest = commitShas[commitShas.length - 1];
      if (!earliest) throw new Error('commits array empty after resolution');
      const parentResolved = await git.resolveCommitRefs(cwd, [`${earliest}~1`], context);
      const parentSha = parentResolved[0];
      if (!parentSha) throw new Error(`could not resolve parent of ${earliest}`);
      baseSha = parentSha;
    }

    const between = await git.getCommitsBetween(cwd, baseSha, resolvedHead, context);
    if (between.commits.length === 0) {
      throw new Error('resolved range is empty');
    }
    const result = await this.opts.diffBridge.openForCommits({
      target,
      base: baseSha,
      head: resolvedHead,
      commits: between.commits,
      includeWorkingTree,
      ...(focusPath ? { focusPath } : {})
    });
    if (!result.ok) throw new Error(result.error);
    return {
      ok: true,
      cwd: result.cwd,
      base: result.base,
      head: result.head,
      commitCount: result.commitCount,
      truncated: between.truncated
    };
  }
}

function hookProviderForUrl(url: string): HookProvider | null {
  switch (url) {
    case '/hook/claude': return 'claude_code';
    case '/hook/codex': return 'codex';
    case '/hook/cursor': return 'cursor';
    case '/hook/opencode': return 'opencode';
    case '/hook/grok': return 'grok_build';
    default: return null;
  }
}

function requestHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function providerHookName(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ['hook_event_name', 'hookEventName', 'hook_event', 'event', 'type']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
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

export const MAX_MCP_REQUEST_BYTES = MAX_ARTIFACT_HTML_BYTES + (2 * 1024 * 1024);

function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      body += chunk;
      if (bytes > maxBytes) {
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

function requiredProvider(args: Record<PropertyKey, unknown>): WorkerAgentProvider {
  const provider = requiredString(args, 'provider');
  if (provider !== 'claude_code' && provider !== 'codex' && provider !== 'cursor') {
    throw new Error('provider must be claude_code, codex, or cursor');
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

function booleanField(args: Record<PropertyKey, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

function requiredStringArray(args: Record<PropertyKey, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be a string array`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${key} must be a string array`);
    out.push(item);
  }
  if (out.length === 0) throw new Error(`${key} is required`);
  return out;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
