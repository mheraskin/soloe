import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentObserverManager } from '../agents/AgentObserverManager.js';
import { SessionStore } from '../sessions/SessionStore.js';
import { Notifier, type NativeNotificationOptions } from './Notifier.js';

describe('Notifier', () => {
  let tmp: string;
  let sessions: SessionStore;
  let observer: AgentObserverManager;
  let shown: NativeNotificationOptions[];
  let notifier: Notifier;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'soloe-notifier-'));
    sessions = new SessionStore(join(tmp, 'sessions.json'));
    await sessions.init();
    observer = new AgentObserverManager();
    shown = [];
    notifier = new Notifier({
      getWindows: () => [],
      nativeFactory: (notification) => ({
        show: () => shown.push(notification)
      }),
      isNativeSupported: () => true,
      shouldShowNative: () => true
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('shows a native notification when a session enters an approval state', async () => {
    const session = await sessions.create({
      kind: 'codex',
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      resumeMode: 'new'
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'working', 'thinking');
    observer.setTuiObservedState(session.id, 'waiting_for_approval', 'approval: docker compose up');

    await vi.waitFor(() => {
      expect(shown).toEqual([
        {
          title: 'Codex: approval needed',
          body: 'approval: docker compose up'
        }
      ]);
    });
  });

  it('dedupes repeated native notifications for the same state', async () => {
    const session = await sessions.create({
      kind: 'claude_code',
      name: 'Claude',
      cwd: '/workspace',
      runMode: 'windows',
      resumeMode: 'new'
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'waiting_for_input', 'waiting for input');
    observer.setTuiObservedState(session.id, 'waiting_for_input', 'waiting for input again');

    await vi.waitFor(() => {
      expect(shown).toHaveLength(1);
    });
    expect(shown[0]?.title).toBe('Claude: input needed');
  });

  it('respects native notification suppression', async () => {
    notifier = new Notifier({
      getWindows: () => [],
      nativeFactory: (notification) => ({
        show: () => shown.push(notification)
      }),
      isNativeSupported: () => true,
      shouldShowNative: () => false
    });
    const session = await sessions.create({
      kind: 'codex',
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      resumeMode: 'new'
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'failed', 'failed');

    await new Promise((resolve) => setImmediate(resolve));
    expect(shown).toEqual([]);
  });

  it('focuses Soloe and activates the session when a native notification is clicked', async () => {
    const sent: unknown[][] = [];
    const clickHandlers: Array<() => void> = [];
    const win = {
      isDestroyed: () => false,
      isMinimized: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        send: (...args: unknown[]) => sent.push(args)
      }
    } as unknown as BrowserWindow;
    notifier = new Notifier({
      getWindows: () => [win],
      nativeFactory: (notification) => ({
        show: () => shown.push(notification),
        on: (_event, listener) => clickHandlers.push(listener)
      }),
      isNativeSupported: () => true,
      shouldShowNative: () => true
    });
    const session = await sessions.create({
      kind: 'codex',
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      resumeMode: 'new'
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'waiting_for_approval', 'approval: docker ps');

    await vi.waitFor(() => {
      expect(clickHandlers).toHaveLength(1);
    });
    clickHandlers[0]?.();

    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(sent).toEqual([['notify:activate-session', session.id]]);
  });
});
