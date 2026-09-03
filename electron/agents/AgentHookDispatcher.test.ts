import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHookDispatcher } from './AgentHookDispatcher.js';
import { AgentObserverManager } from './AgentObserverManager.js';
import { SessionStore } from '../sessions/SessionStore.js';
import type { AutoRenameService } from './AutoRenameService.js';

const argvB64 = (...args: string[]) => Buffer.from(`${args.join('\0')}\0`, 'utf8').toString('base64');

describe('AgentHookDispatcher', () => {
  let tmp: string;
  let observer: AgentObserverManager;
  let sessionStore: SessionStore;
  let dispatcher: AgentHookDispatcher;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'soloe-hook-'));
    observer = new AgentObserverManager();
    sessionStore = new SessionStore(join(tmp, 'sessions.json'));
    await sessionStore.init();
    dispatcher = new AgentHookDispatcher({ observer, sessionStore });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the current directory carried by agent hooks', async () => {
    const onLocation = vi.fn();
    const locationDispatcher = new AgentHookDispatcher({
      observer,
      sessionStore,
      onLocation
    });

    await locationDispatcher.dispatch({
      provider: 'codex',
      soloeSessionId: 'sess-1',
      payload: {
        hook_event_name: 'PreToolUse',
        cwd: '/repo/packages/app'
      }
    });
    await locationDispatcher.dispatch({
      provider: 'codex',
      soloeSessionId: 'sess-1',
      payload: {
        hook_event_name: 'PostToolUse',
        cwd: '/repo/packages/app'
      }
    });

    expect(onLocation).toHaveBeenCalledWith('sess-1', '/repo/packages/app');
    expect(onLocation).toHaveBeenCalledTimes(1);
  });

  describe('claude hook events → observed state', () => {
    it.each([
      ['SessionStart', 'starting'],
      ['UserPromptSubmit', 'working'],
      ['PreToolUse', 'running_tool'],
      ['PermissionRequest', 'waiting_for_approval'],
      ['PostToolUse', 'working'],
      ['Notification', 'waiting_for_input'],
      ['Stop', 'completed'],
      ['StopFailure', 'failed'],
      ['SessionEnd', 'exited'],
      ['PreCompact', 'working']
    ] as const)('%s → %s', async (hookEvent, expectedState) => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: hookEvent }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe(expectedState);
    });

    it('PreToolUse summary includes tool_name', async () => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' }
      });
      const events = observer.listEvents('sess-1');
      expect(events[0]?.summary).toBe('tool: Bash');
    });

    it('maps Claude permission notifications to approval', async () => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Claude needs your permission to use Bash'
        }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('waiting_for_approval');
    });

    it('maps Claude PermissionRequest hooks to approval with tool summary', async () => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash'
        }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('waiting_for_approval');
      expect(observer.listEvents('sess-1')[0]?.summary).toBe('approval: Bash');
    });

    it('keeps auto-approved Claude permission hooks in a working state', async () => {
      const created = await sessionStore.create({
        name: 'Claude',
        cwd: '/tmp',
        runMode: 'linux',
        launch: {
          type: 'agent',
          provider: 'claude_code',
          resumeMode: 'new',
          extraArgs: ['--dangerously-skip-permissions']
        }
      });
      observer.setTuiObservedState(created.id, 'working', 'thinking');

      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'ExitPlanMode'
        }
      });

      expect(observer.getSnapshot(created.id)?.state).toBe('running_tool');
      expect(observer.listEvents(created.id)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'waiting_for_approval' })
        ])
      );
    });

    it('preserves Claude permission notification messages for approval summaries', async () => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: {
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Claude needs permission to use WebFetch'
        }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('waiting_for_approval');
      expect(observer.listEvents('sess-1')[0]?.summary).toBe(
        'Claude needs permission to use WebFetch'
      );
    });

    it('maps Claude idle notifications back to idle instead of approval', async () => {
      observer.setTuiObservedState('sess-1', 'waiting_for_approval', 'waiting for approval');
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: {
          hook_event_name: 'Notification',
          notification_type: 'idle_prompt',
          message: 'Claude is waiting for your input'
        }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('idle');
    });

    it('maps declined Claude update notifications back to idle', async () => {
      observer.setTuiObservedState('sess-1', 'working', 'thinking');
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: {
          hook_event_name: 'Notification',
          message: 'Update declined'
        }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('idle');
      expect(observer.listEvents('sess-1').map((event) => event.summary)).toContain('idle');
    });

    it('maps Claude update prompt notifications to input instead of approval', async () => {
      observer.setTuiObservedState('sess-1', 'working', 'thinking');
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: {
          hook_event_name: 'Notification',
          message: 'Update available. Install now?'
        }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('waiting_for_input');
      expect(observer.listEvents('sess-1').map((event) => event.summary)).toContain(
        'Update available. Install now?'
      );
    });

    it('maps interrupted Claude stops back to idle', async () => {
      observer.setTuiObservedState('sess-1', 'working', 'thinking');
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'Stop', reason: 'user_interrupt' }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('idle');
    });

    it('maps Claude usage-limit failures to a limit badge with reset text', async () => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: {
          hook_event_name: 'StopFailure',
          error: "You've hit your session limit · resets 3:45pm"
        }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('usage_limited');
      expect(observer.getSnapshot('sess-1')?.usageLimit?.resetAtLabel).toBe('3:45pm');
      expect(observer.listEvents('sess-1')[0]?.summary).toBe('usage limit until 3:45pm');
    });

    it('SubagentStop appends an event but does not change state', async () => {
      observer.setTuiObservedState('sess-1', 'working', 'baseline');
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'SubagentStop' }
      });
      expect(observer.getSnapshot('sess-1')?.state).toBe('working');
      const events = observer.listEvents('sess-1');
      expect(events.some((e) => e.summary === 'subagent stopped')).toBe(true);
    });

    it('unknown hook events are ignored', async () => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'WhoKnows' }
      });
      expect(observer.getSnapshot('sess-1')).toBeNull();
    });
  });

  describe('codex hook events → observed state', () => {
    it.each([
      ['SessionStart', 'starting'],
      ['UserPromptSubmit', 'working'],
      ['PreToolUse', 'running_tool'],
      ['PostToolUse', 'working'],
      ['PermissionRequest', 'waiting_for_approval'],
      ['Stop', 'completed']
    ] as const)('%s → %s', async (hookEvent, expectedState) => {
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-2',
        payload: { hook_event_name: hookEvent }
      });
      expect(observer.getSnapshot('sess-2')?.state).toBe(expectedState);
    });

    it('recognizes Codex permission requests from alternate event fields', async () => {
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-2',
        payload: {
          type: 'permission_request',
          tool_name: 'shell',
          command: 'docker compose up'
        }
      });

      expect(observer.getSnapshot('sess-2')?.state).toBe('waiting_for_approval');
      expect(observer.getSnapshot('sess-2')?.interactive?.attention).toMatchObject({
        kind: 'approval',
        summary: 'approval: docker compose up'
      });
      expect(observer.listEvents('sess-2').map((e) => e.summary)).toContain(
        'approval: docker compose up'
      );
    });

    it('keeps auto-approved Codex permission hooks in a working state', async () => {
      const created = await sessionStore.create({
        name: 'Codex',
        cwd: '/tmp',
        runMode: 'linux',
        launch: {
          type: 'agent',
          provider: 'codex',
          resumeMode: 'new',
          extraArgs: ['--dangerously-bypass-approvals-and-sandbox']
        }
      });
      observer.setTuiObservedState(created.id, 'working', 'thinking');

      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'PermissionRequest',
          command: 'find the dogs'
        }
      });

      expect(observer.getSnapshot(created.id)?.state).toBe('running_tool');
      expect(observer.listEvents(created.id)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'waiting_for_approval' })
        ])
      );
    });

    it('clears a stale approval state when Codex now auto-approves permissions', async () => {
      const created = await sessionStore.create({
        name: 'Codex',
        cwd: '/tmp',
        runMode: 'linux',
        launch: {
          type: 'agent',
          provider: 'codex',
          resumeMode: 'new',
          extraArgs: ['--dangerously-bypass-approvals-and-sandbox']
        }
      });
      observer.setTuiObservedState(
        created.id,
        'waiting_for_approval',
        'waiting for approval'
      );

      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'PermissionRequest',
          command: 'docker compose up'
        }
      });

      expect(observer.getSnapshot(created.id)?.state).toBe('running_tool');
      expect(observer.listEvents(created.id)[0]).toMatchObject({
        state: 'running_tool'
      });
    });

    it('uses the effective session config resolver for Codex permission hooks', async () => {
      const created = await sessionStore.create({
        name: 'Codex',
        cwd: '/tmp',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
      });
      const autoApprovesPermissions = vi.fn(async () => true);
      const effectiveConfigDispatcher = new AgentHookDispatcher({
        observer,
        sessionStore,
        autoApprovesPermissions
      });
      observer.setTuiObservedState(created.id, 'working', 'thinking');

      await effectiveConfigDispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'PermissionRequest',
          command: 'docker compose up'
        }
      });

      expect(autoApprovesPermissions).toHaveBeenCalledWith(
        expect.objectContaining({ id: created.id })
      );
      expect(observer.getSnapshot(created.id)?.state).toBe('running_tool');
    });

    it('keeps Codex in approval after the normal prompt and tool hook sequence', async () => {
      const created = await sessionStore.create({
        name: 'Codex',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
      });

      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart', session_id: 'codex-805093' }
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'fix the onboarding test failure' }
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'PreToolUse', tool_name: 'shell' }
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'PermissionRequest' }
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'PostToolUse', tool_name: 'shell' }
      });

      expect(observer.getSnapshot(created.id)).toMatchObject({
        state: 'waiting_for_approval',
        provider: 'codex',
        providerThreadId: 'codex-805093'
      });
      expect(observer.listEvents(created.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: 'waiting_for_approval',
            summary: 'waiting for approval'
          })
        ])
      );
    });

    it('treats approval-required Codex tool hooks as approval instead of running tool', async () => {
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-2',
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'shell',
          tool_input: {
            command: 'docker ps',
            requires_approval: true
          }
        }
      });

      expect(observer.getSnapshot('sess-2')?.state).toBe('waiting_for_approval');
      expect(observer.getSnapshot('sess-2')?.interactive?.attention).toMatchObject({
        kind: 'approval',
        summary: 'approval: docker ps'
      });
      expect(observer.listEvents('sess-2').map((e) => e.summary)).toContain(
        'approval: docker ps'
      );
    });

    it('does not treat non-required Codex approval metadata as approval', async () => {
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-2',
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'shell',
          approval: 'not_required'
        }
      });

      expect(observer.getSnapshot('sess-2')?.state).toBe('running_tool');
    });

    it('maps Codex usage-limit payloads to a limit badge', async () => {
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-2',
        payload: {
          hook_event_name: 'Stop',
          error: "You've hit your usage limit. To get more access now, try again at Apr 13th, 2026 12:46 AM."
        }
      });

      expect(observer.getSnapshot('sess-2')?.state).toBe('usage_limited');
      expect(observer.getSnapshot('sess-2')?.usageLimit?.resetAtLabel).toBe(
        'Apr 13th, 2026 12:46 AM'
      );
    });
  });

  describe('cursor interactive hook events → observed state', () => {
    it.each([
      ['sessionStart', 'starting'],
      ['beforeSubmitPrompt', 'working'],
      ['preToolUse', 'running_tool'],
      ['postToolUse', 'working'],
      ['beforeShellExecution', 'running_tool'],
      ['afterShellExecution', 'working'],
      ['beforeMCPExecution', 'running_tool'],
      ['afterMCPExecution', 'working'],
      ['beforeReadFile', 'running_tool'],
      ['afterFileEdit', 'working'],
      ['preCompact', 'working'],
      ['stop', 'completed'],
      ['sessionEnd', 'exited']
    ] as const)('%s → %s', async (hookEvent, expectedState) => {
      await dispatcher.dispatch({
        provider: 'cursor',
        soloeSessionId: 'sess-cursor',
        payload: { hook_event_name: hookEvent, status: 'completed' }
      });

      expect(observer.getSnapshot('sess-cursor')?.state).toBe(expectedState);
      expect(observer.getSnapshot('sess-cursor')?.interactive?.observation).toBe('exact');
    });

    it('projects an aborted stop as idle and an error stop as failed', async () => {
      await dispatcher.dispatch({
        provider: 'cursor',
        soloeSessionId: 'sess-cursor',
        payload: { hook_event_name: 'stop', status: 'aborted' }
      });
      expect(observer.getSnapshot('sess-cursor')?.state).toBe('idle');

      await dispatcher.dispatch({
        provider: 'cursor',
        soloeSessionId: 'sess-cursor',
        payload: { hook_event_name: 'stop', status: 'error' }
      });
      expect(observer.getSnapshot('sess-cursor')?.state).toBe('failed');
    });

    it('projects an interrupted tool failure as an interrupted idle turn', async () => {
      await dispatcher.dispatch({
        provider: 'cursor',
        soloeSessionId: 'sess-cursor',
        payload: {
          hook_event_name: 'postToolUseFailure',
          is_interrupt: true
        }
      });

      expect(observer.getSnapshot('sess-cursor')).toMatchObject({
        state: 'idle',
        interactive: {
          lifecycle: 'running',
          turn: 'idle',
          attention: { kind: 'none' }
        }
      });
    });

    it('preserves approval attention while later activity hooks arrive', async () => {
      observer.setTuiObservedState(
        'sess-cursor',
        'waiting_for_approval',
        'waiting for approval'
      );

      await dispatcher.dispatch({
        provider: 'cursor',
        soloeSessionId: 'sess-cursor',
        payload: {
          hook_event_name: 'preToolUse',
          tool_name: 'Shell',
          tool_use_id: 'tool-1'
        }
      });

      expect(observer.getSnapshot('sess-cursor')?.state).toBe('waiting_for_approval');
      expect(observer.getSnapshot('sess-cursor')?.interactive).toMatchObject({
        lifecycle: 'running',
        turn: 'running_tool',
        attention: { kind: 'approval' },
        observation: 'degraded'
      });
    });
  });

  describe('OpenCode native events → observed state', () => {
    it('maps session, tool, permission, and idle events', async () => {
      const session = await sessionStore.create({
        name: 'OpenCode',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'opencode', resumeMode: 'new' }
      });
      await dispatcher.dispatch({
        provider: 'opencode',
        soloeSessionId: session.id,
        payload: {
          type: 'session.created',
          properties: { info: { id: 'open-session-1', directory: '/repo' } }
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        provider: 'opencode',
        providerThreadId: 'open-session-1',
        state: 'starting'
      });

      await dispatcher.dispatch({
        provider: 'opencode',
        soloeSessionId: session.id,
        payload: {
          type: 'message.part.updated',
          properties: {
            sessionID: 'open-session-1',
            part: { type: 'tool', tool: 'bash', callID: 'call-1', state: { status: 'running' } }
          }
        }
      });
      expect(observer.getSnapshot(session.id)?.state).toBe('running_tool');

      await dispatcher.dispatch({
        provider: 'opencode',
        soloeSessionId: session.id,
        payload: {
          type: 'permission.asked',
          properties: { sessionID: 'open-session-1', id: 'permission-1', permission: 'bash' }
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        state: 'waiting_for_approval',
        interactive: { attention: { kind: 'approval', requestKey: 'permission-1' } }
      });

      await dispatcher.dispatch({
        provider: 'opencode',
        soloeSessionId: session.id,
        payload: {
          type: 'permission.replied',
          properties: { sessionID: 'open-session-1', requestID: 'permission-1', reply: 'once' }
        }
      });
      expect(observer.getSnapshot(session.id)?.interactive?.attention).toEqual({ kind: 'none' });

      await dispatcher.dispatch({
        provider: 'opencode',
        soloeSessionId: session.id,
        payload: {
          type: 'session.status',
          properties: { sessionID: 'open-session-1', status: { type: 'idle' } }
        }
      });
      expect(observer.getSnapshot(session.id)?.state).toBe('completed');
    });

    it('maps questions to input attention', async () => {
      await dispatcher.dispatch({
        provider: 'opencode',
        soloeSessionId: 'sess-opencode',
        payload: {
          type: 'question.asked',
          properties: { sessionID: 'open-session-1', id: 'question-1' }
        }
      });
      expect(observer.getSnapshot('sess-opencode')).toMatchObject({
        state: 'waiting_for_input',
        interactive: { attention: { kind: 'user_input', requestKey: 'question-1' } }
      });
    });
  });

  describe('Grok Build native events → observed state', () => {
    it('maps session, tool, permission notification, and stop events', async () => {
      const session = await sessionStore.create({
        name: 'Grok Build',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'grok_build', resumeMode: 'new' }
      });
      await dispatcher.dispatch({
        provider: 'grok_build',
        soloeSessionId: session.id,
        payload: {
          hookEventName: 'session_start',
          sessionId: 'grok-session-1',
          cwd: '/repo'
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        provider: 'grok_build',
        providerThreadId: 'grok-session-1',
        state: 'starting'
      });

      await dispatcher.dispatch({
        provider: 'grok_build',
        soloeSessionId: session.id,
        payload: {
          hookEventName: 'pre_tool_use',
          sessionId: 'grok-session-1',
          toolUseId: 'tool-1',
          toolName: 'run_terminal_command'
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        state: 'running_tool',
        interactive: { tool: { id: 'tool-1', name: 'run_terminal_command' } }
      });

      await dispatcher.dispatch({
        provider: 'grok_build',
        soloeSessionId: session.id,
        payload: {
          hookEventName: 'notification',
          sessionId: 'grok-session-1',
          notificationType: 'permission_prompt',
          message: 'Approve this command?'
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        state: 'waiting_for_approval',
        interactive: { attention: { kind: 'approval' } }
      });

      await dispatcher.dispatch({
        provider: 'grok_build',
        soloeSessionId: session.id,
        payload: {
          hookEventName: 'stop',
          sessionId: 'grok-session-1',
          reason: 'end_turn'
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        state: 'completed',
        interactive: { attention: { kind: 'none' } }
      });
      expect(await sessionStore.get(session.id)).toMatchObject({
        providerThreadId: 'grok-session-1',
        launch: { provider: 'grok_build', grokSessionId: 'grok-session-1' }
      });
    });
  });

  describe('antigravity hook events → observed state', () => {
    it('maps session, tool, permission request, and stop events', async () => {
      const session = await sessionStore.create({
        name: 'Antigravity',
        cwd: '/repo',
        runMode: 'linux',
        launch: { type: 'agent', provider: 'antigravity', resumeMode: 'new' }
      });
      await dispatcher.dispatch({
        provider: 'antigravity',
        soloeSessionId: session.id,
        payload: {
          hookEventName: 'session_start',
          conversationId: 'agy-conv-1',
          cwd: '/repo'
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        provider: 'antigravity',
        providerThreadId: 'agy-conv-1',
        state: 'starting'
      });

      await dispatcher.dispatch({
        provider: 'antigravity',
        soloeSessionId: session.id,
        payload: {
          hookEventName: 'pre_tool_use',
          conversationId: 'agy-conv-1',
          toolUseId: 'tool-1',
          toolName: 'run_command'
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        state: 'running_tool',
        interactive: { tool: { id: 'tool-1', name: 'run_command' } }
      });

      await dispatcher.dispatch({
        provider: 'antigravity',
        soloeSessionId: session.id,
        payload: {
          hookEventName: 'permission_request',
          conversationId: 'agy-conv-1',
          message: 'Approve run_command?'
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        state: 'waiting_for_approval',
        interactive: { attention: { kind: 'approval' } }
      });

      await dispatcher.dispatch({
        provider: 'antigravity',
        soloeSessionId: session.id,
        payload: {
          hookEventName: 'stop',
          conversationId: 'agy-conv-1'
        }
      });
      expect(observer.getSnapshot(session.id)).toMatchObject({
        state: 'completed',
        interactive: { attention: { kind: 'none' } }
      });
      expect(await sessionStore.get(session.id)).toMatchObject({
        providerThreadId: 'agy-conv-1',
        launch: { provider: 'antigravity', conversationId: 'agy-conv-1' }
      });
    });
  });

  describe('captures provider session id', () => {
    it('stores claude session id on the matching session', async () => {
      const created = await sessionStore.create({
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' }
      });
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart', session_id: 'claude-uuid-xyz' }
      });
      const updated = await sessionStore.get(created.id);
      expect(updated?.launch.type === 'agent' && updated.launch.claudeSessionId).toBe('claude-uuid-xyz');
      expect(updated?.providerThreadId).toBe('claude-uuid-xyz');
      expect(observer.getSnapshot(created.id)).toMatchObject({
        provider: 'claude_code',
        providerThreadId: 'claude-uuid-xyz',
        state: 'starting'
      });
    });

    it('marks Claude sessions as having user input on UserPromptSubmit', async () => {
      const created = await sessionStore.create({
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' }
      });
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart', session_id: 'claude-uuid-xyz' }
      });
      expect((await sessionStore.get(created.id))?.hasUserInput).toBe(false);

      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' }
      });
      expect((await sessionStore.get(created.id))?.hasUserInput).toBe(true);

      const reloaded = new SessionStore(join(tmp, 'sessions.json'));
      await reloaded.init();
      expect((await reloaded.get(created.id))?.hasUserInput).toBe(true);
    });

    it('stores codex session id on the matching session', async () => {
      const created = await sessionStore.create({
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart', session_id: 'codex-uuid-abc' }
      });
      const updated = await sessionStore.get(created.id);
      expect(updated?.launch.type === 'agent' && updated.launch.codexSessionId).toBe('codex-uuid-abc');
      expect(updated?.providerThreadId).toBe('codex-uuid-abc');
      expect(observer.getSnapshot(created.id)).toMatchObject({
        provider: 'codex',
        providerThreadId: 'codex-uuid-abc',
        state: 'starting'
      });
    });

    it('stores Cursor session identity and launch options on takeover', async () => {
      const created = await sessionStore.create({
        name: 'shell',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'terminal', shell: 'bash' }
      });
      await dispatcher.dispatch({
        provider: 'cursor',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'SessionStart',
          session_id: 'cursor-chat-123',
          source: 'shell_launch',
          argv_b64: argvB64('--model', 'auto', '--mode', 'plan', '--force')
        }
      });
      expect((await sessionStore.get(created.id))?.launch).toMatchObject({
        type: 'agent',
        provider: 'cursor',
        resumeMode: 'new',
        cursorSessionId: 'cursor-chat-123',
        cursorMode: 'plan',
        model: 'auto',
        extraArgs: ['--force']
      });
      expect(observer.getSnapshot(created.id)).toMatchObject({
        provider: 'cursor', providerThreadId: 'cursor-chat-123', state: 'starting'
      });
    });

    it('keeps the preassigned Claude id when a hook has no session_id', async () => {
      const created = await sessionStore.create({
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' }
      });
      const assignedSessionId =
        created.launch.type === 'agent' ? created.launch.claudeSessionId : undefined;
      expect(assignedSessionId).toBeDefined();
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart' }
      });
      const updated = await sessionStore.get(created.id);
      expect(updated?.launch.type === 'agent' ? updated.launch.claudeSessionId : undefined).toBe(
        assignedSessionId
      );
    });

    it('switches the stored agent launch when the hook provider does not match the stored kind', async () => {
      const created = await sessionStore.create({
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' }
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'SessionStart',
          session_id: 'codex-uuid-abc',
          argv_b64: argvB64('--model', 'gpt-5.5')
        }
      });
      const updated = await sessionStore.get(created.id);
      expect(updated?.launch).toMatchObject({
        type: 'agent',
        provider: 'codex',
        resumeMode: 'new',
        codexSessionId: 'codex-uuid-abc',
        model: 'gpt-5.5'
      });
      expect(updated?.providerThreadId).toBe('codex-uuid-abc');
      expect(updated?.currentAgentRuntime).toMatchObject({
        provider: 'codex',
        status: 'active',
        providerThreadId: 'codex-uuid-abc'
      });
      expect(observer.getSnapshot(created.id)).toMatchObject({
        provider: 'codex',
        providerThreadId: 'codex-uuid-abc'
      });
    });

    it('promotes a standard terminal when an agent hook arrives', async () => {
      const created = await sessionStore.create({
        name: 'shell',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'terminal', shell: 'bash' }
      });
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'SessionStart',
          session_id: 'claude-uuid-attached',
          source: 'shell_launch',
          argv_b64: argvB64('--model', 'sonnet', '--dangerously-skip-permissions')
        }
      });
      const updated = await sessionStore.get(created.id);
      expect(updated?.launch).toMatchObject({
        type: 'agent',
        provider: 'claude_code',
        resumeMode: 'new',
        claudeSessionId: 'claude-uuid-attached',
        model: 'sonnet',
        extraArgs: ['--dangerously-skip-permissions']
      });
      expect(updated?.providerThreadId).toBe('claude-uuid-attached');
      expect(updated?.currentAgentRuntime).toMatchObject({
        provider: 'claude_code',
        status: 'active',
        providerThreadId: 'claude-uuid-attached'
      });
      expect(observer.getSnapshot(created.id)).toMatchObject({
        provider: 'claude_code',
        providerThreadId: 'claude-uuid-attached',
        state: 'starting'
      });

      const reloaded = new SessionStore(join(tmp, 'sessions.json'));
      await reloaded.init();
      expect((await reloaded.get(created.id))?.launch).toMatchObject({
        type: 'agent',
        provider: 'claude_code',
        model: 'sonnet',
        extraArgs: ['--dangerously-skip-permissions']
      });
    });

    it('captures a resumed Codex thread id from a shell launch', async () => {
      const created = await sessionStore.create({
        name: 'shell',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'terminal', shell: 'bash' }
      });

      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'SessionStart',
          source: 'shell_launch',
          argv_b64: argvB64('resume', 'codex-resumed-thread')
        }
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'SessionEnd',
          source: 'shell_launch',
          argv_b64: argvB64('resume', 'codex-resumed-thread'),
          exit_code: 0
        }
      });

      const updated = await sessionStore.get(created.id);
      expect(updated?.providerThreadId).toBe('codex-resumed-thread');
      expect(updated?.launch).toMatchObject({
        type: 'agent',
        provider: 'codex',
        codexSessionId: 'codex-resumed-thread'
      });
      expect(updated?.currentAgentRuntime).toMatchObject({
        provider: 'codex',
        status: 'exited',
        providerThreadId: 'codex-resumed-thread'
      });
    });

    it('captures a Codex thread switch before the resumed session submits a prompt', async () => {
      const created = await sessionStore.create({
        name: 'Codex',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
      });

      await dispatcher.captureCodexThread(created.id, 'codex-resumed-in-tui');

      const updated = await sessionStore.get(created.id);
      expect(updated?.providerThreadId).toBe('codex-resumed-in-tui');
      expect(updated?.launch).toMatchObject({
        type: 'agent',
        provider: 'codex',
        codexSessionId: 'codex-resumed-in-tui'
      });
      expect(updated?.currentAgentRuntime).toMatchObject({
        provider: 'codex',
        status: 'active',
        providerThreadId: 'codex-resumed-in-tui'
      });
    });

    it('does not replace a durable Codex thread with a failed bootstrap id', async () => {
      const created = await sessionStore.create({
        name: 'Codex',
        cwd: '/tmp',
        runMode: 'linux',
        launch: {
          type: 'agent',
          provider: 'codex',
          resumeMode: 'new',
          codexSessionId: '019fce46-6a9a-7fb0-8b2c-a23c73388e7d'
        }
      });
      await sessionStore.update(created.id, {
        providerThreadId: '019fce46-6a9a-7fb0-8b2c-a23c73388e7d'
      });
      const validatingDispatcher = new AgentHookDispatcher({
        observer,
        sessionStore,
        isProviderThreadDurable: async (_provider, threadId) =>
          threadId !== '01a019c8-8f8c-78a1-8865-fe5f760beeb0'
      });

      await validatingDispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'SessionStart',
          session_id: '01a019c8-8f8c-78a1-8865-fe5f760beeb0',
          transcript_path: '/missing/failed-bootstrap.jsonl'
        }
      });

      const updated = await sessionStore.get(created.id);
      expect(updated?.providerThreadId).toBe('019fce46-6a9a-7fb0-8b2c-a23c73388e7d');
      expect(updated?.transcriptPath).not.toBe('/missing/failed-bootstrap.jsonl');
      expect(updated?.launch).toMatchObject({
        type: 'agent',
        provider: 'codex',
        codexSessionId: '019fce46-6a9a-7fb0-8b2c-a23c73388e7d'
      });
      expect(updated?.currentAgentRuntime?.providerThreadId).toBe(
        '019fce46-6a9a-7fb0-8b2c-a23c73388e7d'
      );
    });

    it('marks a shell-launched agent idle when the command exits without closing the terminal', async () => {
      const created = await sessionStore.create({
        name: 'shell',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'terminal', shell: 'bash' }
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'SessionStart',
          source: 'shell_launch',
          session_id: 'codex-uuid-attached'
        }
      });

      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: {
          hook_event_name: 'SessionEnd',
          source: 'shell_launch',
          session_id: 'codex-uuid-attached',
          exit_code: 130
        }
      });

      expect(observer.getSnapshot(created.id)?.state).toBe('idle');
      expect((await sessionStore.get(created.id))?.currentAgentRuntime).toMatchObject({
        provider: 'codex',
        status: 'exited',
        providerThreadId: 'codex-uuid-attached'
      });
    });

    it('does not crash when the soloe session id is unknown', async () => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'does-not-exist',
        payload: { hook_event_name: 'SessionStart', session_id: 'claude-uuid-xyz' }
      });
      expect(observer.getSnapshot('does-not-exist')?.state).toBe('starting');
    });

    it('persists distinct session ids when two SessionStart hooks fire concurrently', async () => {
      const a = await sessionStore.create({
        name: 'a',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
      });
      const b = await sessionStore.create({
        name: 'b',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
      });
      await Promise.all([
        dispatcher.dispatch({
          provider: 'codex',
          soloeSessionId: a.id,
          payload: { hook_event_name: 'SessionStart', session_id: 'codex-uuid-a' }
        }),
        dispatcher.dispatch({
          provider: 'codex',
          soloeSessionId: b.id,
          payload: { hook_event_name: 'SessionStart', session_id: 'codex-uuid-b' }
        })
      ]);
      const updatedA = await sessionStore.get(a.id);
      const updatedB = await sessionStore.get(b.id);
      expect(updatedA?.launch.type === 'agent' && updatedA.launch.codexSessionId).toBe('codex-uuid-a');
      expect(updatedB?.launch.type === 'agent' && updatedB.launch.codexSessionId).toBe('codex-uuid-b');
      const reloaded = new SessionStore(join(tmp, 'sessions.json'));
      await reloaded.init();
      const onDiskA = await reloaded.get(a.id);
      const onDiskB = await reloaded.get(b.id);
      expect(onDiskA?.launch.type === 'agent' && onDiskA.launch.codexSessionId).toBe('codex-uuid-a');
      expect(onDiskB?.launch.type === 'agent' && onDiskB.launch.codexSessionId).toBe('codex-uuid-b');
    });
  });

  describe('auto-rename triggering', () => {
    function makeAutoRename() {
      const maybeRename = vi.fn().mockResolvedValue(undefined);
      const stub = { maybeRename } as unknown as AutoRenameService;
      return { stub, maybeRename };
    }

    it('fires auto-rename on UserPromptSubmit after SessionStart', async () => {
      const { stub, maybeRename } = makeAutoRename();
      const renamingDispatcher = new AgentHookDispatcher({
        observer,
        sessionStore,
        autoRename: stub
      });
      await renamingDispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'SessionStart' }
      });
      await renamingDispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'fix the login bug please' }
      });
      expect(maybeRename).toHaveBeenCalledTimes(1);
      expect(maybeRename).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        firstPrompt: 'fix the login bug please'
      });
    });

    it('only fires on the first UserPromptSubmit per SessionStart', async () => {
      const { stub, maybeRename } = makeAutoRename();
      const renamingDispatcher = new AgentHookDispatcher({
        observer,
        sessionStore,
        autoRename: stub
      });
      await renamingDispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'SessionStart' }
      });
      await renamingDispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'one' }
      });
      await renamingDispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'two' }
      });
      expect(maybeRename).toHaveBeenCalledTimes(1);
    });

    it('re-arms on a fresh SessionStart (covers /resume)', async () => {
      const { stub, maybeRename } = makeAutoRename();
      const renamingDispatcher = new AgentHookDispatcher({
        observer,
        sessionStore,
        autoRename: stub
      });
      await renamingDispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'SessionStart' }
      });
      await renamingDispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'first' }
      });
      await renamingDispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'SessionStart' }
      });
      await renamingDispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'second' }
      });
      expect(maybeRename).toHaveBeenCalledTimes(2);
      expect(maybeRename.mock.calls[1]?.[0]).toEqual({
        sessionId: 'sess-1',
        firstPrompt: 'second'
      });
    });

    it('does not fire when UserPromptSubmit arrives without a prior SessionStart', async () => {
      const { stub, maybeRename } = makeAutoRename();
      const renamingDispatcher = new AgentHookDispatcher({
        observer,
        sessionStore,
        autoRename: stub
      });
      await renamingDispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' }
      });
      expect(maybeRename).not.toHaveBeenCalled();
    });

    it('skips when payload has no prompt text', async () => {
      const { stub, maybeRename } = makeAutoRename();
      const renamingDispatcher = new AgentHookDispatcher({
        observer,
        sessionStore,
        autoRename: stub
      });
      await renamingDispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'SessionStart' }
      });
      await renamingDispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'sess-1',
        payload: { hook_event_name: 'UserPromptSubmit' }
      });
      expect(maybeRename).not.toHaveBeenCalled();
    });
  });
});
