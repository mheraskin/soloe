import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentObserverManager } from '../agents/AgentObserverManager.js';
import { SessionStore } from '../sessions/SessionStore.js';
import {
  Notifier,
  type NativeNotificationHandle,
  type NativeNotificationOptions
} from './Notifier.js';

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
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'working', 'thinking');
    observer.setTuiObservedState(session.id, 'waiting_for_approval', 'approval: docker compose up');

    await vi.waitFor(() => {
      expect(shown).toEqual([
        {
          title: 'Approval needed',
          body: 'Codex'
        }
      ]);
    });
  });

  it('uses a compact completion notification', async () => {
    const session = await sessions.create({
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'working', 'thinking');
    observer.setTuiObservedState(session.id, 'completed', 'implementation finished');

    await vi.waitFor(() => {
      expect(shown).toEqual([
        {
          title: 'Tab finished working',
          body: 'Codex'
        }
      ]);
    });
  });

  it('never shows approval notifications for auto-approved Codex sessions', async () => {
    const session = await sessions.create({
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      launch: {
        type: 'agent',
        provider: 'codex',
        resumeMode: 'new',
        extraArgs: ['--dangerously-bypass-approvals-and-sandbox']
      }
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'working', 'thinking');
    observer.setTuiObservedState(
      session.id,
      'waiting_for_approval',
      'approval: docker compose up'
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(shown).toEqual([]);
  });

  it('uses effective approval metadata when config is not in launch arguments', async () => {
    const session = await sessions.create({
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);
    observer.setAutoApprovesPermissions(session.id, true);

    observer.setTuiObservedState(session.id, 'waiting_for_approval', 'approval: docker compose up');

    await new Promise((resolve) => setImmediate(resolve));
    expect(shown).toEqual([]);
  });

  it('dedupes repeated native notifications for the same state', async () => {
    const session = await sessions.create({
      name: 'Claude',
      cwd: '/workspace',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'claude_code', resumeMode: 'new' }
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'waiting_for_input', 'waiting for input');
    observer.setTuiObservedState(session.id, 'waiting_for_input', 'waiting for input again');

    await vi.waitFor(() => {
      expect(shown).toHaveLength(1);
    });
    expect(shown[0]?.title).toBe('Input needed');
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
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
    });
    observer.registerTuiSession(session);
    notifier.attachAgentObserver(observer, sessions);

    observer.setTuiObservedState(session.id, 'failed', 'failed');

    await new Promise((resolve) => setImmediate(resolve));
    expect(shown).toEqual([]);
  });

  it('adds the default native icon to notifications', () => {
    notifier = new Notifier({
      getWindows: () => [],
      nativeFactory: (notification) => ({
        show: () => shown.push(notification)
      }),
      defaultNativeIcon: '/workspace/build/icon.png',
      isNativeSupported: () => true,
      shouldShowNative: () => true
    });

    notifier.native({ title: 'Codex: input needed', body: 'waiting' });

    expect(shown).toEqual([
      {
        title: 'Codex: input needed',
        body: 'waiting',
        icon: '/workspace/build/icon.png'
      }
    ]);
  });

  it('allows callers to override the default native icon', () => {
    notifier = new Notifier({
      getWindows: () => [],
      nativeFactory: (notification) => ({
        show: () => shown.push(notification)
      }),
      defaultNativeIcon: '/workspace/build/icon.png',
      isNativeSupported: () => true,
      shouldShowNative: () => true
    });

    notifier.native({ title: 'Codex: input needed', icon: '/workspace/custom.png' });

    expect(shown).toEqual([
      {
        title: 'Codex: input needed',
        icon: '/workspace/custom.png'
      }
    ]);
  });

  it('focuses Soloe and activates the session when a native notification is clicked', async () => {
    const sent: unknown[][] = [];
    const clickHandlers: Array<() => void> = [];
    const focusApp = vi.fn();
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
        on: (event, listener) => {
          if (event === 'click') clickHandlers.push(listener);
        }
      }),
      isNativeSupported: () => true,
      shouldShowNative: () => true,
      focusApp
    });
    const session = await sessions.create({
      name: 'Codex',
      cwd: '/workspace',
      runMode: 'windows',
      launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
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
    expect(focusApp).toHaveBeenCalled();
    expect(sent).toEqual([['notify:activate-session', session.id]]);
  });

  it('retains native notification handles until the notification closes', () => {
    const closeHandlers: Array<() => void> = [];
    notifier = new Notifier({
      getWindows: () => [],
      nativeFactory: (notification): NativeNotificationHandle => ({
        show: () => shown.push(notification),
        on: (event, listener) => {
          if (event === 'close') closeHandlers.push(listener);
        }
      }),
      isNativeSupported: () => true,
      shouldShowNative: () => true
    });

    notifier.native({ title: 'Codex: input needed' });

    const active = (
      notifier as unknown as { activeNativeNotifications: Set<NativeNotificationHandle> }
    ).activeNativeNotifications;
    expect(active.size).toBe(1);

    closeHandlers[0]?.();

    expect(active.size).toBe(0);
  });
});
