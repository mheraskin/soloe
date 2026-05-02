import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHookDispatcher } from './AgentHookDispatcher.js';
import { AgentObserverManager } from './AgentObserverManager.js';
import { SessionStore } from '../sessions/SessionStore.js';

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
      ['Stop', 'idle'],
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
      ['Stop', 'idle']
    ] as const)('%s → %s', async (hookEvent, expectedState) => {
      await dispatcher.dispatch({
        provider: 'codex',
        soloeSessionId: 'sess-2',
        payload: { hook_event_name: hookEvent }
      });
      expect(observer.getSnapshot('sess-2')?.state).toBe(expectedState);
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

    it('does not crash when the soloe session id is unknown', async () => {
      await dispatcher.dispatch({
        provider: 'claude_code',
        soloeSessionId: 'does-not-exist',
        payload: { hook_event_name: 'SessionStart', session_id: 'claude-uuid-xyz' }
      });
      expect(observer.getSnapshot('does-not-exist')?.state).toBe('starting');
    });
  });
});
