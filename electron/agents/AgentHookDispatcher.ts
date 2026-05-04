import type { AgentObservedState, SessionId } from '@shared/types/sessions.js';
import type { AgentObserverManager } from './AgentObserverManager.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { AutoRenameService } from './AutoRenameService.js';
import type { HookEvent, HookProvider } from './SoloeMcpServer.js';

export interface AgentHookDispatcherOptions {
  observer: AgentObserverManager;
  sessionStore: SessionStore;
  autoRename?: AutoRenameService;
  log?: (message: string, detail?: unknown) => void;
}

interface HookMapping {
  state?: AgentObservedState;
  summary: string;
}

export class AgentHookDispatcher {
  // Sessions that should rename on the *next* UserPromptSubmit. Populated on
  // SessionStart so we cover both fresh sessions and `/resume` restarts —
  // matches the user spec of "first message in session and on /resume".
  private readonly pendingAutoRename = new Set<SessionId>();

  constructor(private readonly opts: AgentHookDispatcherOptions) {}

  async dispatch(event: HookEvent): Promise<void> {
    if (event.provider === 'claude_code') {
      await this.dispatchClaude(event.soloeSessionId, event.payload);
      return;
    }
    await this.dispatchCodex(event.soloeSessionId, event.payload);
  }

  async dispatchClaude(soloeSessionId: SessionId, payload: Record<string, unknown>): Promise<void> {
    const hookEvent = hookEventName(payload);
    if (hookEvent === 'SessionStart') {
      this.pendingAutoRename.add(soloeSessionId);
      console.log(`[soloe-rename] dispatcher: SessionStart armed for ${soloeSessionId} (claude)`);
    }
    if (hookEvent === 'UserPromptSubmit') {
      const prompt = stringField(payload, 'prompt') ?? stringField(payload, 'user_message');
      this.maybeTriggerAutoRename(soloeSessionId, prompt, 'claude');
    }
    const mapping = mapClaudeHook(hookEvent, payload);
    if (mapping) this.applyMapping(soloeSessionId, mapping, payload);
    await this.captureProviderSessionId(soloeSessionId, payload, 'claude_code');
  }

  async dispatchCodex(soloeSessionId: SessionId, payload: Record<string, unknown>): Promise<void> {
    const hookEvent = hookEventName(payload);
    if (hookEvent === 'SessionStart') {
      this.pendingAutoRename.add(soloeSessionId);
      console.log(`[soloe-rename] dispatcher: SessionStart armed for ${soloeSessionId} (codex)`);
    }
    if (hookEvent === 'UserPromptSubmit') {
      const prompt = stringField(payload, 'prompt') ?? stringField(payload, 'user_message');
      this.maybeTriggerAutoRename(soloeSessionId, prompt, 'codex');
    }
    const mapping = mapCodexHook(hookEvent, payload);
    if (mapping) this.applyMapping(soloeSessionId, mapping, payload);
    await this.captureProviderSessionId(soloeSessionId, payload, 'codex');
  }

  private maybeTriggerAutoRename(
    soloeSessionId: SessionId,
    prompt: string | undefined,
    providerLabel: 'claude' | 'codex'
  ): void {
    if (!this.opts.autoRename) {
      console.log(
        `[soloe-rename] dispatcher: UserPromptSubmit skipped — no autoRename service (${providerLabel} ${soloeSessionId})`
      );
      return;
    }
    if (!this.pendingAutoRename.has(soloeSessionId)) {
      console.log(
        `[soloe-rename] dispatcher: UserPromptSubmit skipped — not pending (no SessionStart seen yet for ${providerLabel} ${soloeSessionId})`
      );
      return;
    }
    this.pendingAutoRename.delete(soloeSessionId);
    if (!prompt) {
      console.log(
        `[soloe-rename] dispatcher: UserPromptSubmit skipped — empty prompt field (${providerLabel} ${soloeSessionId})`
      );
      return;
    }
    console.log(
      `[soloe-rename] dispatcher: firing maybeRename for ${providerLabel} ${soloeSessionId} promptLen=${prompt.length}`
    );
    void this.opts.autoRename
      .maybeRename({ sessionId: soloeSessionId, firstPrompt: prompt })
      .catch((err) => this.opts.log?.('auto-rename dispatch failed', err));
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
      if (provider === 'claude_code' && existing.kind !== 'claude_code') return;
      if (provider === 'codex' && existing.kind !== 'codex') return;
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
      this.opts.observer.updateTuiProviderThread(soloeSessionId, provider, sessionId);
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
      return mapClaudeNotification(payload);
    case 'Stop':
      return { state: 'completed', summary: 'completed' };
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

function mapClaudeNotification(payload: Record<string, unknown>): HookMapping {
  const notificationType = stringField(payload, 'notification_type');
  const message = stringField(payload, 'message') ?? '';
  const lowerMessage = message.toLowerCase();

  if (notificationType === 'idle_prompt' || lowerMessage.includes('waiting for your input')) {
    return { state: 'idle', summary: 'idle' };
  }

  if (notificationType === 'permission_prompt' || lowerMessage.includes('permission')) {
    return { state: 'waiting_for_approval', summary: 'waiting for approval' };
  }

  return { state: 'waiting_for_approval', summary: 'waiting for approval' };
}

function mapCodexHook(
  hookEvent: string | undefined,
  payload: Record<string, unknown>
): HookMapping | null {
  if (isCodexPermissionRequest(hookEvent, payload)) {
    return {
      state: 'waiting_for_approval',
      summary: codexPermissionSummary(payload)
    };
  }

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
    case 'Stop':
      return { state: 'completed', summary: 'completed' };
    default:
      return null;
  }
}

function hookEventName(payload: Record<string, unknown>): string | undefined {
  return (
    stringField(payload, 'hook_event_name')
    ?? stringField(payload, 'hook_event')
    ?? stringField(payload, 'event')
    ?? stringField(payload, 'type')
    ?? stringField(payload, 'name')
  );
}

function isCodexPermissionRequest(
  hookEvent: string | undefined,
  payload: Record<string, unknown>
): boolean {
  const normalizedEvent = normalizeEventName(hookEvent);
  if (
    normalizedEvent === 'permissionrequest'
    || normalizedEvent === 'permissionrequested'
    || normalizedEvent === 'approvalrequest'
    || normalizedEvent === 'approvalrequested'
  ) {
    return true;
  }

  return booleanField(payload, 'approval_required')
    || booleanField(payload, 'requires_approval')
    || booleanField(payload, 'permission_required')
    || booleanField(payload, 'requires_permission')
    || statusStringIndicatesRequest(payload, 'approval')
    || statusStringIndicatesRequest(payload, 'permission')
    || nestedBooleanField(payload, ['tool', 'approval_required'])
    || nestedBooleanField(payload, ['tool', 'requires_approval'])
    || nestedBooleanField(payload, ['tool_input', 'approval_required'])
    || nestedBooleanField(payload, ['tool_input', 'requires_approval'])
    || nestedBooleanField(payload, ['input', 'approval_required'])
    || nestedBooleanField(payload, ['input', 'requires_approval'])
    || nestedBooleanField(payload, ['arguments', 'approval_required'])
    || nestedBooleanField(payload, ['arguments', 'requires_approval']);
}

function codexPermissionSummary(payload: Record<string, unknown>): string {
  const command =
    stringField(payload, 'command')
    ?? nestedStringField(payload, ['tool_input', 'command'])
    ?? nestedStringField(payload, ['input', 'command'])
    ?? nestedStringField(payload, ['arguments', 'command']);
  if (command) return `approval: ${shortText(command, 72)}`;

  const toolName =
    stringField(payload, 'tool_name')
    ?? stringField(payload, 'tool')
    ?? nestedStringField(payload, ['tool', 'name']);
  if (toolName) return `approval: ${toolName}`;

  return 'waiting for approval';
}

function normalizeEventName(value: string | undefined): string {
  return (value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function booleanField(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

function statusStringIndicatesRequest(payload: Record<string, unknown>, key: string): boolean {
  const value = stringField(payload, key);
  if (!value) return false;
  const normalized = normalizeEventName(value);
  return normalized === 'request'
    || normalized === 'requested'
    || normalized === 'required'
    || normalized === 'pending'
    || normalized === 'waiting'
    || normalized === 'prompt'
    || normalized === 'ask'
    || normalized === 'approvalrequired'
    || normalized === 'permissionrequired';
}

function nestedStringField(payload: Record<string, unknown>, path: string[]): string | undefined {
  const value = nestedField(payload, path);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nestedBooleanField(payload: Record<string, unknown>, path: string[]): boolean {
  return nestedField(payload, path) === true;
}

function nestedField(payload: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = payload;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortText(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
