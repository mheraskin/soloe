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
