import type { AgentObservedState, Session, SessionId, SessionUpdate } from '@shared/types/sessions.js';
import { launchProvider } from '@shared/types/sessions.js';
import type { AgentObserverManager } from './AgentObserverManager.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { AutoRenameService } from './AutoRenameService.js';
import type { HookEvent, HookProvider } from './SoloeMcpServer.js';
import { detectUsageLimit } from './UsageLimitDetector.js';
import type { UsageLimitInfo } from './UsageLimitDetector.js';

export interface AgentHookDispatcherOptions {
  observer: AgentObserverManager;
  sessionStore: SessionStore;
  autoRename?: AutoRenameService;
  onSessionChange?: (session: Session) => void;
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
      await this.markClaudeHasUserInput(soloeSessionId);
    }
    const usageLimit = detectUsageLimit(payload);
    if (usageLimit) {
      await this.logUsageLimitDetection({
        provider: 'claude_code',
        soloeSessionId,
        hookEvent,
        source: 'hook',
        usageLimit,
        payload
      });
      this.opts.observer.setTuiUsageLimit(soloeSessionId, {
        ...usageLimit,
        detectedAt: new Date().toISOString()
      });
      await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'claude_code', hookEvent);
      return;
    }
    const mapping = mapClaudeHook(hookEvent, payload);
    if (mapping) this.applyMapping(soloeSessionId, mapping, payload);
    await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'claude_code', hookEvent);
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
    const usageLimit = detectUsageLimit(payload);
    if (usageLimit) {
      await this.logUsageLimitDetection({
        provider: 'codex',
        soloeSessionId,
        hookEvent,
        source: 'hook',
        usageLimit,
        payload
      });
      this.opts.observer.setTuiUsageLimit(soloeSessionId, {
        ...usageLimit,
        detectedAt: new Date().toISOString()
      });
      await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'codex', hookEvent);
      return;
    }
    const mapping = mapCodexHook(hookEvent, payload);
    if (mapping) this.applyMapping(soloeSessionId, mapping, payload);
    await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'codex', hookEvent);
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

  private async logUsageLimitDetection(input: {
    provider: HookProvider;
    soloeSessionId: SessionId;
    hookEvent: string | undefined;
    source: 'hook';
    usageLimit: UsageLimitInfo;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const session = await this.opts.sessionStore.get(input.soloeSessionId).catch(() => null);
    console.log('[soloe-limit] usage limit detected by hook dispatcher', {
      source: input.source,
      provider: input.provider,
      hookEvent: input.hookEvent ?? null,
      sessionId: input.soloeSessionId,
      sessionName: session?.name ?? null,
      cwd: session?.cwd ?? null,
      runMode: session?.runMode ?? null,
      launchProvider: session ? launchProvider(session) : null,
      currentAgentRuntime: session?.currentAgentRuntime ?? null,
      providerThreadId: session?.providerThreadId ?? null,
      transcriptPath: session?.transcriptPath ?? null,
      usageLimit: {
        message: input.usageLimit.message,
        resetAtLabel: input.usageLimit.resetAtLabel ?? null,
        detectorVersion: input.usageLimit.detectorVersion,
        matchedText: input.usageLimit.matchedText ?? null
      },
      payloadKeys: Object.keys(input.payload),
      payloadTextFields: textFieldsForLog(input.payload),
      payloadSnippet: shortJson(input.payload, 2400)
    });
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

  private async syncCurrentAgentRuntime(
    soloeSessionId: SessionId,
    payload: Record<string, unknown>,
    provider: HookProvider,
    hookEvent: string | undefined
  ): Promise<void> {
    const sessionId = stringField(payload, 'session_id');
    try {
      const existing = await this.opts.sessionStore.get(soloeSessionId);
      if (!existing) return;

      const existingRuntime = existing.currentAgentRuntime;
      const startsRuntime = hookEvent === 'SessionStart';
      const canUpdateRuntime =
        startsRuntime || !existingRuntime || existingRuntime.provider === provider;
      if (!canUpdateRuntime) return;

      const now = new Date().toISOString();
      const matchingLaunch = launchProvider(existing) === provider;
      const priorProviderThreadId =
        existingRuntime?.provider === provider ? existingRuntime.providerThreadId : undefined;
      const runtime = {
        provider,
        status: hookEvent === 'SessionEnd' ? 'exited' as const : 'active' as const,
        providerThreadId: sessionId ?? priorProviderThreadId,
        startedAt: startsRuntime ? now : existingRuntime?.startedAt,
        lastEventAt: now
      };

      const patch = {
        currentAgentRuntime: runtime,
        providerThreadId: runtime.providerThreadId
      } as SessionUpdate;
      const transcriptPath = stringField(payload, 'transcript_path');
      if (transcriptPath) patch.transcriptPath = transcriptPath;

      if (sessionId && provider === 'claude_code' && matchingLaunch && existing.launch.type === 'agent') {
        patch.launch = { ...existing.launch, claudeSessionId: sessionId };
      }
      if (sessionId && provider === 'codex' && matchingLaunch && existing.launch.type === 'agent') {
        patch.launch = { ...existing.launch, codexSessionId: sessionId };
      }

      const changed =
        existing.currentAgentRuntime?.provider !== runtime.provider
        || existing.currentAgentRuntime?.status !== runtime.status
        || existing.currentAgentRuntime?.providerThreadId !== runtime.providerThreadId
        || existing.providerThreadId !== patch.providerThreadId
        || (transcriptPath !== undefined && existing.transcriptPath !== transcriptPath)
        || (sessionId && provider === 'claude_code' && matchingLaunch && existing.launch.type === 'agent'
          && existing.launch.claudeSessionId !== sessionId)
        || (sessionId && provider === 'codex' && matchingLaunch && existing.launch.type === 'agent'
          && existing.launch.codexSessionId !== sessionId);
      if (!changed) return;

      const updated = await this.opts.sessionStore.update(soloeSessionId, patch);
      this.opts.onSessionChange?.(updated);
      if (runtime.providerThreadId) {
        this.opts.observer.updateTuiProviderThread(soloeSessionId, provider, runtime.providerThreadId);
      } else {
        this.opts.observer.updateTuiProviderThread(soloeSessionId, provider);
      }
    } catch (err) {
      this.opts.log?.('failed to sync current agent runtime', err);
    }
  }

  private async markClaudeHasUserInput(soloeSessionId: SessionId): Promise<void> {
    try {
      const existing = await this.opts.sessionStore.get(soloeSessionId);
      if (!existing) return;
      if (launchProvider(existing) !== 'claude_code') return;
      if (existing.hasUserInput === true) return;
      await this.opts.sessionStore.update(soloeSessionId, { hasUserInput: true });
    } catch (err) {
      this.opts.log?.('failed to mark session input', err);
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
    case 'PermissionRequest':
      return {
        state: 'waiting_for_approval',
        summary: claudePermissionSummary(payload)
      };
    case 'PostToolUse':
      return { state: 'working', summary: 'thinking' };
    case 'Notification':
      return mapClaudeNotification(payload);
    case 'Interrupt':
    case 'UserInterrupt':
      return { state: 'idle', summary: 'idle' };
    case 'Stop':
      if (isInterruptedClaudeStop(payload)) {
        return { state: 'idle', summary: 'idle' };
      }
      return { state: 'completed', summary: 'completed' };
    case 'SessionEnd':
      return { state: 'exited', summary: 'session ended' };
    case 'StopFailure': {
      const usageLimit = detectUsageLimit(payload);
      if (usageLimit) return { state: 'usage_limited', summary: usageLimit.message };
      return { state: 'failed', summary: 'failed' };
    }
    case 'PreCompact':
      return { state: 'working', summary: 'compacting context' };
    case 'SubagentStop':
      return { summary: 'subagent stopped' };
    default:
      return null;
  }
}

function isInterruptedClaudeStop(payload: Record<string, unknown>): boolean {
  const candidates = [
    stringField(payload, 'reason'),
    stringField(payload, 'message'),
    stringField(payload, 'stop_reason'),
    stringField(payload, 'status'),
    stringField(payload, 'result'),
    nestedStringField(payload, ['stop', 'reason']),
    nestedStringField(payload, ['event', 'reason'])
  ];
  return candidates.some((value) => {
    const normalized = normalizeEventName(value);
    return normalized.includes('interrupt')
      || normalized.includes('cancel')
      || normalized.includes('abort');
  });
}

function mapClaudeNotification(payload: Record<string, unknown>): HookMapping {
  const notificationType = stringField(payload, 'notification_type');
  const message = stringField(payload, 'message') ?? '';
  const lowerMessage = message.toLowerCase();
  const summary = notificationSummary(message, 'waiting for approval');

  if (notificationType === 'idle_prompt' || lowerMessage.includes('waiting for your input')) {
    return { state: 'idle', summary: 'idle' };
  }

  if (isDismissedUpdateNotification(lowerMessage)) {
    return { state: 'idle', summary: 'idle' };
  }

  if (notificationType === 'permission_prompt' || lowerMessage.includes('permission')) {
    return { state: 'waiting_for_approval', summary };
  }

  if (isCompletedNotification(lowerMessage)) {
    return { state: 'completed', summary };
  }

  return { state: 'waiting_for_input', summary: notificationSummary(message, 'waiting for input') };
}

function notificationSummary(message: string, fallback: string): string {
  const normalized = message.trim().replace(/\s+/g, ' ');
  return normalized || fallback;
}

function isDismissedUpdateNotification(lowerMessage: string): boolean {
  if (!lowerMessage.includes('update')) return false;
  return lowerMessage.includes('declined')
    || lowerMessage.includes('denied')
    || lowerMessage.includes('rejected')
    || lowerMessage.includes('cancelled')
    || lowerMessage.includes('canceled')
    || lowerMessage.includes('skipped')
    || lowerMessage.includes('not now');
}

function isCompletedNotification(lowerMessage: string): boolean {
  return lowerMessage.includes('task completed')
    || lowerMessage.includes('completed successfully')
    || lowerMessage.includes('response complete');
}

function claudePermissionSummary(payload: Record<string, unknown>): string {
  const toolName = stringField(payload, 'tool_name');
  return toolName ? `approval: ${toolName}` : 'waiting for approval';
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

function textFieldsForLog(payload: Record<string, unknown>, prefix = '', depth = 0): Record<string, string> {
  if (depth > 4) return {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isSensitiveKey(key)) {
      output[path] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      if (/error|message|limit|reason|status|detail|event|type|name|session|transcript/i.test(path)) {
        output[path] = shortText(value, 500);
      }
      continue;
    }
    if (isRecord(value)) {
      Object.assign(output, textFieldsForLog(value, path, depth + 1));
    }
  }
  return output;
}

function shortJson(value: unknown, maxLength: number): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(value, (key, inner) => {
    if (isSensitiveKey(key)) return '[redacted]';
    if (typeof inner === 'string') return shortText(inner, 1000);
    if (inner && typeof inner === 'object') {
      if (seen.has(inner)) return '[circular]';
      seen.add(inner);
    }
    return inner;
  });
  if (!json || json.length <= maxLength) return json ?? '';
  return `${json.slice(0, maxLength - 3)}...`;
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|cookie|api[_-]?key/i.test(key);
}
