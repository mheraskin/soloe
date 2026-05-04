import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHookDispatcher } from './AgentHookDispatcher.js';
import { AgentObserverManager } from './AgentObserverManager.js';
import { SessionStore } from '../sessions/SessionStore.js';
import type { AutoRenameService } from './AutoRenameService.js';

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
      ['PostToolUse', 'working'],
      ['Notification', 'waiting_for_approval'],
      ['Stop', 'completed'],
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
  });

  describe('captures provider session id', () => {
    it('stores claude session id on the matching session', async () => {
      const created = await sessionStore.create({
        kind: 'claude_code',
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        resumeMode: 'new'
      });
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart', session_id: 'claude-uuid-xyz' }
      });
      const updated = await sessionStore.get(created.id);
      expect(updated && 'claudeSessionId' in updated && updated.claudeSessionId).toBe(
        'claude-uuid-xyz'
      );
      expect(updated?.providerThreadId).toBe('claude-uuid-xyz');
      expect(observer.getSnapshot(created.id)).toMatchObject({
        provider: 'claude_code',
        providerThreadId: 'claude-uuid-xyz',
        state: 'starting'
      });
    });

    it('stores codex session id on the matching session', async () => {
      const created = await sessionStore.create({
        kind: 'codex',
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        resumeMode: 'new'
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart', session_id: 'codex-uuid-abc' }
      });
      const updated = await sessionStore.get(created.id);
      expect(updated && 'codexSessionId' in updated && updated.codexSessionId).toBe(
        'codex-uuid-abc'
      );
      expect(updated?.providerThreadId).toBe('codex-uuid-abc');
      expect(observer.getSnapshot(created.id)).toMatchObject({
        provider: 'codex',
        providerThreadId: 'codex-uuid-abc',
        state: 'starting'
      });
    });

    it('skips capture when payload has no session_id', async () => {
      const created = await sessionStore.create({
        kind: 'claude_code',
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        resumeMode: 'new'
      });
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart' }
      });
      const updated = await sessionStore.get(created.id);
      expect((updated as { claudeSessionId?: string } | null)?.claudeSessionId).toBeUndefined();
    });

    it('skips capture when the hook provider does not match the Soloe session kind', async () => {
      const created = await sessionStore.create({
        kind: 'claude_code',
        name: 'work',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        resumeMode: 'new'
      });
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: created.id,
        payload: { hook_event_name: 'SessionStart', session_id: 'codex-uuid-abc' }
      });
      const updated = await sessionStore.get(created.id);
      expect((updated as { codexSessionId?: string } | null)?.codexSessionId).toBeUndefined();
      expect(updated?.providerThreadId).toBeUndefined();
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
        kind: 'codex',
        name: 'a',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        resumeMode: 'new'
      });
      const b = await sessionStore.create({
        kind: 'codex',
        name: 'b',
        cwd: '/tmp',
        runMode: 'wsl',
        wslDistro: 'Ubuntu',
        resumeMode: 'new'
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
      expect((updatedA as { codexSessionId?: string } | null)?.codexSessionId).toBe('codex-uuid-a');
      expect((updatedB as { codexSessionId?: string } | null)?.codexSessionId).toBe('codex-uuid-b');
      const reloaded = new SessionStore(join(tmp, 'sessions.json'));
      await reloaded.init();
      const onDiskA = await reloaded.get(a.id);
      const onDiskB = await reloaded.get(b.id);
      expect((onDiskA as { codexSessionId?: string } | null)?.codexSessionId).toBe('codex-uuid-a');
      expect((onDiskB as { codexSessionId?: string } | null)?.codexSessionId).toBe('codex-uuid-b');
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
