import type {
  AgentLaunch,
  AgentObservedState,
  Session,
  SessionId,
  SessionUpdate
} from '@shared/types/sessions.js';
import { launchProvider } from '@shared/types/sessions.js';
import { sessionAutoApprovesPermissions } from '@shared/agent-permissions.js';
import type { AgentObserverManager } from './AgentObserverManager.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { AutoRenameService } from './AutoRenameService.js';
import type { HookEvent, HookProvider } from './SoloeMcpServer.js';
import { detectUsageLimit } from './UsageLimitDetector.js';
import type { UsageLimitInfo } from './UsageLimitDetector.js';
import type { InteractiveAgentEvent } from '@shared/interactive-agent-projection.js';

export interface AgentHookDispatcherOptions {
  observer: AgentObserverManager;
  sessionStore: SessionStore;
  autoRename?: Pick<AutoRenameService, 'maybeRename'>;
  onSessionChange?: (session: Session) => void;
  onLocation?: (sessionId: SessionId, cwd: string) => void | Promise<void>;
  autoApprovesPermissions?: (session: Session) => boolean | Promise<boolean>;
  isProviderThreadDurable?: (
    provider: HookProvider,
    providerThreadId: string
  ) => boolean | Promise<boolean>;
  log?: (message: string, detail?: unknown) => void;
}

interface HookMapping {
  state?: AgentObservedState;
  summary: string;
  resolvesApproval?: boolean;
}

export class AgentHookDispatcher {
  // Sessions that should rename on the *next* UserPromptSubmit. Populated on
  // SessionStart so we cover both fresh sessions and `/resume` restarts —
  // matches the user spec of "first message in session and on /resume".
  private readonly pendingAutoRename = new Set<SessionId>();
  private readonly reportedCwds = new Map<SessionId, string>();

  constructor(private readonly opts: AgentHookDispatcherOptions) {}

  async dispatch(event: HookEvent): Promise<void> {
    const hookEvent = hookEventName(event.payload);
    // The bridge records the provider payload before this dispatcher runs when
    // raw Session tracing is enabled. Only the normalized projection is durable.
    this.opts.log?.('interactive hook received', {
      provider: event.provider,
      soloeSessionId: event.soloeSessionId,
      hookEvent: hookEvent ?? null,
      payload: event.payload
    });
    await this.reportLocation(event.soloeSessionId, event.payload);
    try {
      if (event.provider === 'claude_code') {
        await this.dispatchClaude(event.soloeSessionId, event.payload);
        return;
      }
      if (event.provider === 'codex') {
        await this.dispatchCodex(event.soloeSessionId, event.payload);
        return;
      }
      if (event.provider === 'cursor') {
        await this.dispatchCursor(event.soloeSessionId, event.payload);
        return;
      }
      if (event.provider === 'opencode') {
        await this.dispatchOpenCode(event.soloeSessionId, event.payload);
        return;
      }
      await this.dispatchGrok(event.soloeSessionId, event.payload);
    } finally {
      const normalizedEvent = normalizeEventName(hookEvent);
      if (normalizedEvent === 'sessionend' || normalizedEvent === 'sessiondeleted') {
        this.reportedCwds.delete(event.soloeSessionId);
      }
    }
  }

  private async reportLocation(
    sessionId: SessionId,
    payload: Record<string, unknown>
  ): Promise<void> {
    const cwd = (
      stringField(payload, 'cwd')
      ?? nestedStringField(payload, ['properties', 'info', 'directory'])
    )?.trim();
    if (!cwd || cwd === this.reportedCwds.get(sessionId)) return;
    this.reportedCwds.set(sessionId, cwd);
    try {
      await this.opts.onLocation?.(sessionId, cwd);
    } catch (error) {
      this.reportedCwds.delete(sessionId);
      this.opts.log?.('terminal location dispatch failed', error);
    }
  }

  async captureCodexThread(
    soloeSessionId: SessionId,
    providerThreadId: string
  ): Promise<void> {
    await this.syncCurrentAgentRuntime(
      soloeSessionId,
      { session_id: providerThreadId, source: 'shell_snapshot' },
      'codex',
      undefined
    );
  }

  async dispatchClaude(soloeSessionId: SessionId, payload: Record<string, unknown>): Promise<void> {
    const hookEvent = hookEventName(payload);
    if (hookEvent === 'SessionStart') {
      this.pendingAutoRename.add(soloeSessionId);
    }
    if (hookEvent === 'UserPromptSubmit') {
      const prompt = stringField(payload, 'prompt') ?? stringField(payload, 'user_message');
      this.maybeTriggerAutoRename(soloeSessionId, prompt);
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
    const mapping = await this.resolvePermissionMapping(
      soloeSessionId,
      mapClaudeHook(hookEvent, payload),
      payload
    );
    if (mapping) {
      this.applyMapping(
        soloeSessionId,
        mapping,
        payload,
        interactiveEventForHook('claude_code', hookEvent, payload, mapping)
      );
    }
    await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'claude_code', hookEvent);
  }

  async dispatchCodex(soloeSessionId: SessionId, payload: Record<string, unknown>): Promise<void> {
    const hookEvent = hookEventName(payload);
    if (hookEvent === 'SessionStart') {
      this.pendingAutoRename.add(soloeSessionId);
    }
    if (hookEvent === 'UserPromptSubmit') {
      const prompt = stringField(payload, 'prompt') ?? stringField(payload, 'user_message');
      this.maybeTriggerAutoRename(soloeSessionId, prompt);
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
    const mapping = await this.resolvePermissionMapping(
      soloeSessionId,
      mapCodexHook(hookEvent, payload),
      payload
    );
    if (mapping) {
      this.applyMapping(
        soloeSessionId,
        mapping,
        payload,
        interactiveEventForHook('codex', hookEvent, payload, mapping)
      );
    }
    await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'codex', hookEvent);
  }

  async dispatchCursor(soloeSessionId: SessionId, payload: Record<string, unknown>): Promise<void> {
    const hookEvent = hookEventName(payload);
    const normalizedEvent = normalizeEventName(hookEvent);
    if (normalizedEvent === 'sessionstart') this.pendingAutoRename.add(soloeSessionId);
    if (normalizedEvent === 'beforesubmitprompt') {
      const prompt = stringField(payload, 'prompt') ?? stringField(payload, 'user_message');
      this.maybeTriggerAutoRename(soloeSessionId, prompt);
    }
    const mapping = await this.resolvePermissionMapping(
      soloeSessionId,
      mapCursorHook(hookEvent, payload),
      payload
    );
    if (mapping) {
      this.applyMapping(
        soloeSessionId,
        mapping,
        payload,
        interactiveEventForHook('cursor', hookEvent, payload, mapping)
      );
    }
    await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'cursor', hookEvent);
  }

  async dispatchOpenCode(
    soloeSessionId: SessionId,
    payload: Record<string, unknown>
  ): Promise<void> {
    const hookEvent = hookEventName(payload);
    const normalizedEvent = normalizeEventName(hookEvent);
    if (normalizedEvent === 'sessioncreated' || normalizedEvent === 'sessionstart') {
      this.pendingAutoRename.add(soloeSessionId);
    }
    if (normalizedEvent === 'soloeuserprompt') {
      this.maybeTriggerAutoRename(soloeSessionId, openCodePrompt(payload));
    }
    const mapping = await this.resolvePermissionMapping(
      soloeSessionId,
      mapOpenCodeHook(hookEvent, payload),
      openCodeProperties(payload)
    );
    if (mapping) {
      this.applyMapping(
        soloeSessionId,
        mapping,
        openCodeProperties(payload),
        interactiveEventForHook('opencode', hookEvent, payload, mapping)
      );
    }
    await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'opencode', hookEvent);
  }

  async dispatchGrok(
    soloeSessionId: SessionId,
    payload: Record<string, unknown>
  ): Promise<void> {
    const hookEvent = hookEventName(payload);
    const normalizedEvent = normalizeEventName(hookEvent);
    if (normalizedEvent === 'sessionstart') this.pendingAutoRename.add(soloeSessionId);
    if (normalizedEvent === 'userpromptsubmit') {
      const prompt = stringField(payload, 'prompt') ?? stringField(payload, 'userPrompt');
      this.maybeTriggerAutoRename(soloeSessionId, prompt);
    }
    const usageLimit = detectUsageLimit(payload);
    if (usageLimit) {
      await this.logUsageLimitDetection({
        provider: 'grok_build',
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
      await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'grok_build', hookEvent);
      return;
    }
    const mapping = await this.resolvePermissionMapping(
      soloeSessionId,
      mapGrokHook(hookEvent, payload),
      payload
    );
    if (mapping) {
      this.applyMapping(
        soloeSessionId,
        mapping,
        payload,
        interactiveEventForHook('grok_build', hookEvent, payload, mapping)
      );
    }
    await this.syncCurrentAgentRuntime(soloeSessionId, payload, 'grok_build', hookEvent);
  }

  private maybeTriggerAutoRename(
    soloeSessionId: SessionId,
    prompt: string | undefined
  ): void {
    if (!this.opts.autoRename) return;
    if (!this.pendingAutoRename.has(soloeSessionId)) return;
    this.pendingAutoRename.delete(soloeSessionId);
    if (!prompt) return;
    void this.opts.autoRename
      .maybeRename({ sessionId: soloeSessionId, firstPrompt: prompt })
      .catch((err) => this.opts.log?.('auto-rename dispatch failed', err));
  }

  private async resolvePermissionMapping(
    soloeSessionId: SessionId,
    mapping: HookMapping | null,
    payload: Record<string, unknown>
  ): Promise<HookMapping | null> {
    if (mapping?.state !== 'waiting_for_approval') return mapping;
    const session = await this.opts.sessionStore.get(soloeSessionId).catch(() => null);
    const autoApproves = session
      ? await (this.opts.autoApprovesPermissions?.(session)
        ?? sessionAutoApprovesPermissions(session))
      : false;
    if (session) {
      this.opts.observer.setAutoApprovesPermissions(soloeSessionId, autoApproves);
    }
    if (!autoApproves) {
      return mapping;
    }
    // Codex runs PermissionRequest hooks before routing the request to its
    // configured reviewer. An auto-review hook event therefore describes an
    // automatic review in progress, not a prompt that Soloe should show.
    return {
      state: 'running_tool',
      summary: autoApprovedToolSummary(payload),
      resolvesApproval: true
    };
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
    payload: Record<string, unknown>,
    interactiveEvent: InteractiveAgentEvent | null
  ): void {
    if (mapping.state) {
      const current = this.opts.observer.getSnapshot(soloeSessionId);
      if (!mapping.resolvesApproval && shouldPreserveApproval(current?.state, mapping.state)) {
        if (interactiveEvent) {
          this.opts.observer.applyTuiInteractiveEvent(
            soloeSessionId,
            interactiveEvent,
            current?.state ?? 'waiting_for_approval',
            current?.state === 'waiting_for_approval'
              ? 'waiting for approval'
              : mapping.summary
          );
          return;
        }
        this.opts.observer.appendEvent({
          subjectId: soloeSessionId,
          subjectKind: current?.subjectKind ?? 'session',
          state: current?.state ?? 'waiting_for_approval',
          summary: current?.state === 'waiting_for_approval' ? 'waiting for approval' : mapping.summary
        });
        return;
      }
      const detail = stringField(payload, 'message') ?? stringField(payload, 'reason');
      if (interactiveEvent) {
        this.opts.observer.applyTuiInteractiveEvent(
          soloeSessionId,
          interactiveEvent,
          mapping.state,
          mapping.summary,
          detail
        );
        return;
      }
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
    const reportedSessionId = providerSessionId(payload, provider);
    try {
      const existing = await this.opts.sessionStore.get(soloeSessionId);
      if (!existing) return;

      const sessionId = reportedSessionId && await this.isDurableProviderThread(
        provider,
        reportedSessionId
      )
        ? reportedSessionId
        : undefined;
      const rejectedSessionId = reportedSessionId !== undefined && sessionId === undefined;

      const existingRuntime = existing.currentAgentRuntime;
      const normalizedEvent = normalizeEventName(hookEvent);
      const startsRuntime = normalizedEvent === 'sessionstart' || normalizedEvent === 'sessioncreated';
      const canUpdateRuntime =
        startsRuntime || !existingRuntime || existingRuntime.provider === provider;
      if (!canUpdateRuntime) return;

      const now = new Date().toISOString();
      const priorProviderThreadId =
        existingRuntime?.provider === provider
          ? existingRuntime.providerThreadId ?? existing.providerThreadId
          : launchProvider(existing) === provider
            ? existing.providerThreadId
            : undefined;
      const runtime = {
        provider,
        status: normalizedEvent === 'sessionend' || normalizedEvent === 'sessiondeleted'
          ? 'exited' as const
          : 'active' as const,
        providerThreadId: sessionId ?? priorProviderThreadId,
        startedAt: startsRuntime ? now : existingRuntime?.startedAt,
        lastEventAt: now
      };

      const patch = {
        currentAgentRuntime: runtime,
        providerThreadId: runtime.providerThreadId
      } as SessionUpdate;
      const transcriptPath = rejectedSessionId
        ? undefined
        : stringField(payload, 'transcript_path');
      if (transcriptPath) patch.transcriptPath = transcriptPath;

      const launchPatch = buildLaunchPatch(existing, provider, sessionId, payload, startsRuntime);
      if (launchPatch) {
        patch.launch = launchPatch;
      }

      const changed =
        existing.currentAgentRuntime?.provider !== runtime.provider
        || existing.currentAgentRuntime?.status !== runtime.status
        || existing.currentAgentRuntime?.providerThreadId !== runtime.providerThreadId
        || existing.providerThreadId !== patch.providerThreadId
        || (transcriptPath !== undefined && existing.transcriptPath !== transcriptPath)
        || (launchPatch !== null && !sameLaunch(existing.launch, launchPatch));
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

  private async isDurableProviderThread(
    provider: HookProvider,
    providerThreadId: string
  ): Promise<boolean> {
    if (!this.opts.isProviderThreadDurable) return true;
    try {
      return await this.opts.isProviderThreadDurable(provider, providerThreadId);
    } catch (error) {
      this.opts.log?.('provider thread durability check failed', error);
      return false;
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

function interactiveEventForHook(
  provider: HookProvider,
  hookEvent: string | undefined,
  payload: Record<string, unknown>,
  mapping: HookMapping
): InteractiveAgentEvent | null {
  const event = normalizeEventName(hookEvent);
  const providerSession = providerSessionId(payload, provider);
  const properties = provider === 'opencode' ? openCodeProperties(payload) : payload;
  const providerTurn = provider === 'cursor'
    ? stringField(payload, 'generation_id')
    : provider === 'codex'
      ? stringField(payload, 'turn_id')
      : provider === 'opencode'
        ? stringField(properties, 'messageID') ?? nestedStringField(properties, ['part', 'messageID'])
        : stringField(payload, 'prompt_id');
  const toolId = stringField(properties, 'tool_use_id')
    ?? stringField(properties, 'toolUseId')
    ?? stringField(properties, 'tool_call_id')
    ?? nestedStringField(properties, ['part', 'callID'])
    ?? stringField(properties, 'requestID')
    ?? stringField(properties, 'id');
  const toolName = stringField(properties, 'tool_name')
    ?? stringField(properties, 'toolName')
    ?? nestedStringField(properties, ['part', 'tool'])
    ?? (event.includes('shell') ? 'Shell' : undefined)
    ?? (event.includes('mcp') ? 'MCP' : undefined)
    ?? (event.includes('readfile') ? 'Read' : undefined)
    ?? (event.includes('fileedit') ? 'Write' : undefined)
    ?? (event.includes('subagent') ? 'Subagent' : undefined)
    ?? 'Tool';

  if (event === 'sessionstart' || event === 'sessioncreated') {
    return {
      type: 'session.started',
      ...(providerSession ? { providerSessionId: providerSession } : {})
    };
  }
  if (event === 'sessionend' || event === 'sessiondeleted') {
    return {
      type: 'session.ended',
      outcome: mapping.state === 'failed' ? 'failed' : 'exited',
      summary: mapping.summary
    };
  }
  if (
    event === 'userpromptsubmit'
    || event === 'beforesubmitprompt'
    || event === 'soloeuserprompt'
  ) {
    return {
      type: 'turn.submitted',
      ...(providerTurn ? { providerTurnId: providerTurn } : {})
    };
  }
  if (mapping.state === 'waiting_for_approval') {
    return {
      type: 'approval.requested',
      ...(toolId ? { requestKey: toolId } : {}),
      summary: mapping.summary
    };
  }
  if (mapping.state === 'waiting_for_input') {
    return {
      type: 'input.requested',
      ...(toolId ? { requestKey: toolId } : {}),
      summary: mapping.summary
    };
  }
  if (mapping.resolvesApproval) {
    return { type: 'attention.resolved' };
  }
  if (
    event === 'pretooluse'
    || event === 'beforeshellexecution'
    || event === 'beforemcpexecution'
    || event === 'beforereadfile'
    || event === 'subagentstart'
    || (event === 'messagepartupdated' && mapping.state === 'running_tool')
  ) {
    return {
      type: 'tool.started',
      tool: { ...(toolId ? { id: toolId } : {}), name: toolName }
    };
  }
  if (
    event === 'posttooluse'
    || event === 'posttoolbatch'
    || event === 'aftershellexecution'
    || event === 'aftermcpexecution'
    || event === 'afterfileedit'
    || event === 'subagentstop'
    || (event === 'messagepartupdated' && mapping.state === 'working')
  ) {
    return { type: 'tool.finished' };
  }
  if (event === 'posttoolusefailure') {
    if (mapping.state === 'idle') {
      return { type: 'turn.stopped', outcome: 'interrupted', summary: mapping.summary };
    }
    if (mapping.state === 'failed') {
      return { type: 'runtime.failed', summary: mapping.summary };
    }
    return { type: 'tool.finished' };
  }
  if (
    event === 'stop'
    || event === 'stopfailure'
    || event === 'sessionidle'
    || (event === 'sessionstatus' && mapping.state === 'completed')
  ) {
    return {
      type: 'turn.stopped',
      outcome: mapping.state === 'failed'
        ? 'failed'
        : mapping.state === 'idle' ? 'interrupted' : 'completed',
      summary: mapping.summary
    };
  }
  if (mapping.state === 'failed') {
    return { type: 'runtime.failed', summary: mapping.summary };
  }
  if (
    event === 'precompact'
    || event === 'postcompact'
    || event === 'afteragentresponse'
    || event === 'afteragentthought'
    || mapping.state === 'working'
  ) {
    return {
      type: 'turn.submitted',
      ...(providerTurn ? { providerTurnId: providerTurn } : {})
    };
  }
  return null;
}

function shouldPreserveApproval(
  current: AgentObservedState | undefined,
  next: AgentObservedState
): boolean {
  return current === 'waiting_for_approval'
    && (next === 'working' || next === 'running_tool');
}

function buildLaunchPatch(
  existing: Session,
  provider: HookProvider,
  providerSessionId: string | undefined,
  payload: Record<string, unknown>,
  startsRuntime: boolean
): AgentLaunch | null {
  const capturedArgs = decodeArgvPayload(payload);
  const hasCapturedArgs = capturedArgs !== null;
  const shouldPromote =
    startsRuntime && (existing.launch.type === 'terminal' || existing.launch.provider !== provider);
  const shouldRefreshMatchingAgent =
    existing.launch.type === 'agent'
    && existing.launch.provider === provider
    && (providerSessionId !== undefined || hasCapturedArgs);

  if (!shouldPromote && !shouldRefreshMatchingAgent) return null;

  const base: AgentLaunch =
    existing.launch.type === 'agent' && existing.launch.provider === provider
      ? { ...existing.launch }
      : { type: 'agent', provider, resumeMode: 'new' };

  if (provider === 'claude_code') {
    delete base.codexSessionId;
    delete base.cursorSessionId;
    delete base.openCodeSessionId;
    delete base.grokSessionId;
    delete base.cursorMode;
    delete base.reasoningEffort;
    if (providerSessionId) base.claudeSessionId = providerSessionId;
    if (existing.launch.type === 'agent' && existing.launch.provider === 'claude_code') {
      base.fullscreenTui = existing.launch.fullscreenTui;
    }
  } else if (provider === 'codex') {
    delete base.claudeSessionId;
    delete base.claudeSessionName;
    delete base.cursorSessionId;
    delete base.openCodeSessionId;
    delete base.grokSessionId;
    delete base.cursorMode;
    delete base.fullscreenTui;
    if (providerSessionId) base.codexSessionId = providerSessionId;
  } else if (provider === 'cursor') {
    delete base.claudeSessionId;
    delete base.claudeSessionName;
    delete base.codexSessionId;
    delete base.reasoningEffort;
    delete base.fullscreenTui;
    delete base.openCodeSessionId;
    delete base.grokSessionId;
    if (providerSessionId) base.cursorSessionId = providerSessionId;
  } else if (provider === 'opencode') {
    delete base.claudeSessionId;
    delete base.claudeSessionName;
    delete base.codexSessionId;
    delete base.cursorSessionId;
    delete base.cursorMode;
    delete base.reasoningEffort;
    delete base.fullscreenTui;
    delete base.grokSessionId;
    if (providerSessionId) base.openCodeSessionId = providerSessionId;
  } else {
    delete base.claudeSessionId;
    delete base.claudeSessionName;
    delete base.codexSessionId;
    delete base.cursorSessionId;
    delete base.openCodeSessionId;
    delete base.cursorMode;
    delete base.reasoningEffort;
    delete base.fullscreenTui;
    if (providerSessionId) base.grokSessionId = providerSessionId;
  }

  if (hasCapturedArgs) {
    const parsed = parseAgentLaunchArgs(provider, capturedArgs);
    if (parsed.model !== undefined) base.model = parsed.model;
    else delete base.model;
    if (provider === 'codex' && parsed.reasoningEffort !== undefined) {
      base.reasoningEffort = parsed.reasoningEffort;
    } else if (provider === 'codex') {
      delete base.reasoningEffort;
    }
    if (provider === 'cursor' && parsed.cursorMode !== undefined) base.cursorMode = parsed.cursorMode;
    else if (provider === 'cursor') delete base.cursorMode;
    if (parsed.extraArgs.length > 0) base.extraArgs = parsed.extraArgs;
    else delete base.extraArgs;
  }

  return base;
}

function sameLaunch(a: Session['launch'], b: Session['launch']): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function decodeArgvPayload(payload: Record<string, unknown>): string[] | null {
  const raw = stringField(payload, 'argv_b64') ?? stringField(payload, 'argvB64');
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return decoded.split('\0').filter((arg) => arg.length > 0);
  } catch {
    return [];
  }
}

function providerSessionId(
  payload: Record<string, unknown>,
  provider: HookProvider
): string | undefined {
  if (provider === 'opencode') {
    const properties = openCodeProperties(payload);
    const reported = stringField(properties, 'sessionID')
      ?? stringField(properties, 'sessionId')
      ?? nestedStringField(properties, ['info', 'id'])
      ?? nestedStringField(properties, ['part', 'sessionID']);
    if (reported) return reported;
  }
  const reported = stringField(payload, 'session_id') ?? stringField(payload, 'sessionId');
  if (reported) return reported;
  const capturedArgs = decodeArgvPayload(payload);
  return capturedArgs ? parseAgentLaunchArgs(provider, capturedArgs).providerSessionId : undefined;
}

function parseAgentLaunchArgs(
  provider: HookProvider,
  args: string[]
): {
  providerSessionId?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  cursorMode?: 'agent' | 'plan' | 'ask';
  extraArgs: string[];
} {
  const extraArgs: string[] = [];
  let providerSessionId: string | undefined;
  let model: string | undefined;
  let reasoningEffort: 'low' | 'medium' | 'high' | undefined;
  let cursorMode: 'agent' | 'plan' | 'ask' | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const next = args[i + 1];

    if (provider === 'codex' && i === 0 && arg === 'resume') {
      if (next && !next.startsWith('-')) {
        providerSessionId = next;
        i += 1;
      }
      continue;
    }
    if (provider === 'claude_code' && (arg === '--resume' || arg === '-r')) {
      if (next) {
        providerSessionId = next;
        i += 1;
      }
      continue;
    }
    if (provider === 'claude_code' && arg.startsWith('--resume=')) {
      providerSessionId = arg.slice('--resume='.length);
      continue;
    }
    if (provider === 'claude_code' && arg === '--continue') continue;
    if (provider === 'cursor' && arg === '--resume') {
      if (next && !next.startsWith('-')) {
        providerSessionId = next;
        i += 1;
      }
      continue;
    }
    if (provider === 'cursor' && arg.startsWith('--resume=')) {
      providerSessionId = arg.slice('--resume='.length);
      continue;
    }
    if (provider === 'cursor' && arg === '--continue') continue;
    if (provider === 'opencode' && (arg === '--session' || arg === '-s')) {
      if (next && !next.startsWith('-')) {
        providerSessionId = next;
        i += 1;
      }
      continue;
    }
    if (provider === 'opencode' && arg.startsWith('--session=')) {
      providerSessionId = arg.slice('--session='.length);
      continue;
    }
    if (provider === 'opencode' && (arg === '--continue' || arg === '-c')) continue;
    if (provider === 'grok_build' && (arg === '--resume' || arg === '-r')) {
      if (next && !next.startsWith('-')) {
        providerSessionId = next;
        i += 1;
      }
      continue;
    }
    if (provider === 'grok_build' && arg.startsWith('--resume=')) {
      providerSessionId = arg.slice('--resume='.length);
      continue;
    }
    if (provider === 'grok_build' && (arg === '--continue' || arg === '-c')) continue;

    if (provider === 'cursor' && arg === '--mode') {
      if (next === 'agent' || next === 'plan' || next === 'ask') {
        cursorMode = next;
        i += 1;
      }
      continue;
    }
    if (provider === 'cursor' && arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (value === 'agent' || value === 'plan' || value === 'ask') cursorMode = value;
      continue;
    }

    if (arg === '--model' || arg === '-m') {
      if (next) {
        model = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length);
      continue;
    }

    if (provider === 'codex' && arg === '-c') {
      const parsed = parseCodexReasoningEffort(next);
      if (parsed) {
        reasoningEffort = parsed;
        i += 1;
        continue;
      }
    }
    if (provider === 'codex') {
      const parsed = parseCodexReasoningEffort(arg);
      if (parsed) {
        reasoningEffort = parsed;
        continue;
      }
    }

    extraArgs.push(arg);
  }
  return {
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(cursorMode ? { cursorMode } : {}),
    extraArgs
  };
}

function parseCodexReasoningEffort(value: string | undefined): 'low' | 'medium' | 'high' | null {
  if (!value) return null;
  const match = value.match(/^model_reasoning_effort=(low|medium|high)$/);
  return match ? match[1] as 'low' | 'medium' | 'high' : null;
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
    case 'PostToolUseFailure':
      return booleanField(payload, 'is_interrupt')
        ? { state: 'idle', summary: 'interrupted' }
        : { state: 'working', summary: 'tool failed' };
    case 'PostToolBatch':
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
      if (stringField(payload, 'source') === 'shell_launch') {
        return { state: 'idle', summary: 'idle' };
      }
      return { state: 'exited', summary: 'session ended' };
    case 'StopFailure': {
      const usageLimit = detectUsageLimit(payload);
      if (usageLimit) return { state: 'usage_limited', summary: usageLimit.message };
      return { state: 'failed', summary: 'failed' };
    }
    case 'PreCompact':
      return { state: 'working', summary: 'compacting context' };
    case 'PostCompact':
      return { state: 'working', summary: 'thinking' };
    case 'SubagentStart':
      return { state: 'running_tool', summary: 'running subagent' };
    case 'SubagentStop':
      return { state: 'working', summary: 'subagent stopped' };
    case 'Elicitation':
      return { state: 'waiting_for_input', summary: 'waiting for input' };
    case 'ElicitationResult':
      return { state: 'working', summary: 'thinking' };
    case 'TaskCreated':
    case 'TaskCompleted':
      return { state: 'working', summary: 'thinking' };
    case 'MessageDisplay':
      return { summary: 'assistant response' };
    default:
      return null;
  }
}

function mapCursorHook(
  hookEvent: string | undefined,
  payload: Record<string, unknown>
): HookMapping | null {
  const normalized = normalizeEventName(hookEvent);
  const toolName = stringField(payload, 'tool_name');
  const toolSummary = toolName ? `tool: ${toolName}` : 'running tool';

  switch (normalized) {
    case 'sessionstart':
      return { state: 'starting', summary: 'session started' };
    case 'sessionend':
      return normalizeEventName(stringField(payload, 'reason')) === 'error'
        ? { state: 'failed', summary: 'session failed', resolvesApproval: true }
        : { state: 'exited', summary: 'session ended', resolvesApproval: true };
    case 'beforesubmitprompt':
      return { state: 'working', summary: 'thinking' };
    case 'pretooluse':
    case 'beforeshellexecution':
    case 'beforemcpexecution':
    case 'beforereadfile':
    case 'subagentstart':
      return { state: 'running_tool', summary: toolSummary };
    case 'posttooluse':
    case 'aftershellexecution':
    case 'aftermcpexecution':
    case 'afterfileedit':
    case 'subagentstop':
      return { state: 'working', summary: 'thinking' };
    case 'posttoolusefailure':
      if (booleanField(payload, 'is_interrupt')) {
        return { state: 'idle', summary: 'interrupted' };
      }
      return { state: 'working', summary: 'tool failed' };
    case 'precompact':
      return { state: 'working', summary: 'compacting context' };
    case 'afteragentresponse':
      return { state: 'working', summary: 'finishing response' };
    case 'afteragentthought':
      return { state: 'working', summary: 'thinking' };
    case 'stop': {
      const status = normalizeEventName(stringField(payload, 'status'));
      if (status === 'error') {
        return { state: 'failed', summary: 'failed', resolvesApproval: true };
      }
      if (status === 'aborted') {
        return { state: 'idle', summary: 'interrupted', resolvesApproval: true };
      }
      return { state: 'completed', summary: 'completed', resolvesApproval: true };
    }
    default:
      return null;
  }
}

function mapOpenCodeHook(
  hookEvent: string | undefined,
  payload: Record<string, unknown>
): HookMapping | null {
  const event = normalizeEventName(hookEvent);
  const properties = openCodeProperties(payload);
  const status = normalizeEventName(nestedStringField(properties, ['status', 'type']));
  const partType = normalizeEventName(nestedStringField(properties, ['part', 'type']));
  const toolStatus = normalizeEventName(
    nestedStringField(properties, ['part', 'state', 'status'])
  );
  const toolName = nestedStringField(properties, ['part', 'tool']);

  switch (event) {
    case 'sessionstart':
    case 'sessioncreated':
      return { state: 'starting', summary: 'session started' };
    case 'sessionend':
      return stringField(properties, 'source') === 'shell_launch'
        ? { state: 'idle', summary: 'idle', resolvesApproval: true }
        : { state: 'exited', summary: 'session ended', resolvesApproval: true };
    case 'sessiondeleted':
      return { state: 'exited', summary: 'session ended', resolvesApproval: true };
    case 'sessionerror':
      return { state: 'failed', summary: 'session failed', resolvesApproval: true };
    case 'sessionidle':
      return { state: 'completed', summary: 'completed', resolvesApproval: true };
    case 'sessionstatus':
      if (status === 'busy' || status === 'retry') {
        return { state: 'working', summary: status === 'retry' ? 'retrying' : 'thinking' };
      }
      if (status === 'idle') {
        return { state: 'completed', summary: 'completed', resolvesApproval: true };
      }
      return null;
    case 'soloeuserprompt':
      return { state: 'working', summary: 'thinking' };
    case 'permissionasked':
      return {
        state: 'waiting_for_approval',
        summary: stringField(properties, 'permission')
          ? `approval: ${stringField(properties, 'permission')}`
          : 'waiting for approval'
      };
    case 'permissionreplied':
      return { state: 'working', summary: 'thinking', resolvesApproval: true };
    case 'questionasked':
      return { state: 'waiting_for_input', summary: 'waiting for input' };
    case 'questionreplied':
    case 'questionrejected':
      return { state: 'working', summary: 'thinking', resolvesApproval: true };
    case 'messagepartupdated':
      if (partType !== 'tool') return null;
      if (toolStatus === 'pending' || toolStatus === 'running') {
        return {
          state: 'running_tool',
          summary: toolName ? `tool: ${toolName}` : 'running tool'
        };
      }
      if (toolStatus === 'error') {
        return { state: 'working', summary: 'tool failed' };
      }
      if (toolStatus === 'completed') {
        return { state: 'working', summary: 'thinking' };
      }
      return null;
    default:
      return null;
  }
}

function mapGrokHook(
  hookEvent: string | undefined,
  payload: Record<string, unknown>
): HookMapping | null {
  const event = normalizeEventName(hookEvent);
  const toolName = stringField(payload, 'toolName') ?? stringField(payload, 'tool_name');
  switch (event) {
    case 'sessionstart':
      return { state: 'starting', summary: 'session started' };
    case 'userpromptsubmit':
      return { state: 'working', summary: 'thinking' };
    case 'pretooluse':
      return {
        state: 'running_tool',
        summary: toolName ? `tool: ${toolName}` : 'running tool'
      };
    case 'posttooluse':
      return { state: 'working', summary: 'thinking' };
    case 'posttoolusefailure':
      return { state: 'working', summary: 'tool failed' };
    case 'permissiondenied':
      return { state: 'working', summary: 'permission denied', resolvesApproval: true };
    case 'notification': {
      const message = stringField(payload, 'message') ?? 'waiting for input';
      const notificationType = normalizeEventName(
        stringField(payload, 'notificationType') ?? stringField(payload, 'notification_type')
      );
      if (notificationType.includes('permission')) {
        return {
          state: 'waiting_for_approval',
          summary: notificationSummary(message, 'waiting for approval')
        };
      }
      if (notificationType === 'idleprompt') return { state: 'idle', summary: 'idle' };
      return {
        state: 'waiting_for_input',
        summary: notificationSummary(message, 'waiting for input')
      };
    }
    case 'stop':
      return { state: 'completed', summary: 'completed', resolvesApproval: true };
    case 'stopfailure':
      return { state: 'failed', summary: 'failed', resolvesApproval: true };
    case 'precompact':
      return { state: 'working', summary: 'compacting context' };
    case 'postcompact':
      return { state: 'working', summary: 'thinking' };
    case 'subagentstart':
      return { state: 'running_tool', summary: 'running subagent' };
    case 'subagentstop':
      return { state: 'working', summary: 'thinking' };
    case 'sessionend':
      return stringField(payload, 'source') === 'shell_launch'
        ? { state: 'idle', summary: 'idle', resolvesApproval: true }
        : { state: 'exited', summary: 'session ended', resolvesApproval: true };
    default:
      return null;
  }
}

function openCodeProperties(payload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(payload['properties']) ? payload['properties'] : payload;
}

function openCodePrompt(payload: Record<string, unknown>): string | undefined {
  const parts = openCodeProperties(payload)['parts'];
  if (!Array.isArray(parts)) return undefined;
  const text = parts
    .map((part) => isRecord(part) && typeof part['text'] === 'string' ? part['text'] : '')
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || undefined;
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
    case 'PreCompact':
      return { state: 'working', summary: 'compacting context' };
    case 'PostCompact':
      return { state: 'working', summary: 'thinking' };
    case 'SubagentStart':
      return { state: 'running_tool', summary: 'running subagent' };
    case 'SubagentStop':
      return { state: 'working', summary: 'thinking' };
    case 'Stop':
      return { state: 'completed', summary: 'completed' };
    case 'SessionEnd':
      if (stringField(payload, 'source') === 'shell_launch') {
        return { state: 'idle', summary: 'idle' };
      }
      return { state: 'exited', summary: 'session ended' };
    default:
      return null;
  }
}

function hookEventName(payload: Record<string, unknown>): string | undefined {
  return (
    stringField(payload, 'hookEventName')
    ?? stringField(payload, 'hook_event_name')
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

function autoApprovedToolSummary(payload: Record<string, unknown>): string {
  const toolName =
    stringField(payload, 'tool_name')
    ?? stringField(payload, 'tool')
    ?? nestedStringField(payload, ['tool', 'name']);
  return toolName ? `tool: ${toolName}` : 'running tool';
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
