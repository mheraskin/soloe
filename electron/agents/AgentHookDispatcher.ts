import type { AgentObservedState, SessionId } from '@shared/types/sessions.js';
import type { AgentObserverManager } from './AgentObserverManager.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { HookEvent, HookProvider } from './SoloeMcpServer.js';

export interface AgentHookDispatcherOptions {
  observer: AgentObserverManager;
  sessionStore: SessionStore;
  log?: (message: string, detail?: unknown) => void;
}

interface HookMapping {
  state?: AgentObservedState;
  summary: string;
}

export class AgentHookDispatcher {
  constructor(private readonly opts: AgentHookDispatcherOptions) {}

  async dispatch(event: HookEvent): Promise<void> {
    if (event.provider === 'claude_code') {
      await this.dispatchClaude(event.soloeSessionId, event.payload);
      return;
    }
    await this.dispatchCodex(event.soloeSessionId, event.payload);
  }

  async dispatchClaude(soloeSessionId: SessionId, payload: Record<string, unknown>): Promise<void> {
    const hookEvent = stringField(payload, 'hook_event_name');
    const mapping = mapClaudeHook(hookEvent, payload);
    if (mapping) this.applyMapping(soloeSessionId, mapping, payload);
    await this.captureProviderSessionId(soloeSessionId, payload, 'claude_code');
  }

  async dispatchCodex(soloeSessionId: SessionId, payload: Record<string, unknown>): Promise<void> {
    const hookEvent = stringField(payload, 'hook_event_name');
    const mapping = mapCodexHook(hookEvent, payload);
    if (mapping) this.applyMapping(soloeSessionId, mapping, payload);
    await this.captureProviderSessionId(soloeSessionId, payload, 'codex');
  }

  private applyMapping(
    soloeSessionId: SessionId,
    mapping: HookMapping,
    payload: Record<string, unknown>
  ): void {
    if (mapping.state) {
      const detail = stringField(payload, 'message') ?? stringField(payload, 'reason');
      this.opts.observer.setTuiObservedState(
        soloeSessionId,
        mapping.state,
        mapping.summary,
        detail
      );
      return;
    }
    const snapshot = this.opts.observer.getSnapshot(soloeSessionId);
    this.opts.observer.appendEvent({
      subjectId: soloeSessionId,
      subjectKind: snapshot?.subjectKind ?? 'session',
      state: snapshot?.state ?? 'idle',
      summary: mapping.summary
    });
  }

  private async captureProviderSessionId(
    soloeSessionId: SessionId,
    payload: Record<string, unknown>,
    provider: HookProvider
  ): Promise<void> {
    const sessionId = stringField(payload, 'session_id');
    if (!sessionId) return;
    try {
      const existing = await this.opts.sessionStore.get(soloeSessionId);
      if (!existing) return;
      const patch =
        provider === 'claude_code'
          ? { claudeSessionId: sessionId, providerThreadId: sessionId }
          : { codexSessionId: sessionId, providerThreadId: sessionId };
      const current =
        provider === 'claude_code'
          ? (existing as { claudeSessionId?: string }).claudeSessionId
          : (existing as { codexSessionId?: string }).codexSessionId;
      if (current === sessionId && existing.providerThreadId === sessionId) return;
      await this.opts.sessionStore.update(soloeSessionId, patch);
    } catch (err) {
      this.opts.log?.('failed to capture provider session id', err);
    }
  }
}

function mapClaudeHook(
  hookEvent: string | undefined,
  payload: Record<string, unknown>
): HookMapping | null {
  switch (hookEvent) {
    case 'SessionStart':
      return { state: 'starting', summary: 'session started' };
    case 'UserPromptSubmit':
      return { state: 'working', summary: 'thinking' };
    case 'PreToolUse': {
      const toolName = stringField(payload, 'tool_name');
      return {
        state: 'running_tool',
        summary: toolName ? `tool: ${toolName}` : 'running tool'
      };
    }
    case 'PostToolUse':
      return { state: 'working', summary: 'thinking' };
    case 'Notification':
      return { state: 'waiting_for_approval', summary: 'waiting for approval' };
    case 'Stop':
      return { state: 'idle', summary: 'idle' };
    case 'SessionEnd':
      return { state: 'exited', summary: 'session ended' };
    case 'PreCompact':
      return { state: 'working', summary: 'compacting context' };
    case 'SubagentStop':
      return { summary: 'subagent stopped' };
    default:
      return null;
  }
}

function mapCodexHook(
  hookEvent: string | undefined,
  payload: Record<string, unknown>
): HookMapping | null {
  switch (hookEvent) {
    case 'SessionStart':
      return { state: 'starting', summary: 'session started' };
    case 'UserPromptSubmit':
      return { state: 'working', summary: 'thinking' };
    case 'PreToolUse': {
      const toolName = stringField(payload, 'tool_name');
      return {
        state: 'running_tool',
        summary: toolName ? `tool: ${toolName}` : 'running tool'
      };
    }
    case 'PostToolUse':
      return { state: 'working', summary: 'thinking' };
    case 'PermissionRequest':
      return { state: 'waiting_for_approval', summary: 'waiting for approval' };
    case 'Stop':
      return { state: 'idle', summary: 'idle' };
    default:
      return null;
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
