import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentObserverManager } from '../agents/AgentObserverManager.js';
import { SessionStore } from '../sessions/SessionStore.js';
import { AgentNotificationService } from './AgentNotificationService.js';
import type { NativeNotification } from './Notifier.js';

describe('AgentNotificationService', () => {
  let tmp: string;
  let observer: AgentObserverManager;
  let sessionStore: SessionStore;
  let native: ReturnType<typeof vi.fn<(notification: NativeNotification) => void>>;
  let service: AgentNotificationService;

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmp = mkdtempSync(join(tmpdir(), 'soloe-agent-notifications-'));
    observer = new AgentObserverManager();
    sessionStore = new SessionStore(join(tmp, 'sessions.json'));
    await sessionStore.init();
    native = vi.fn();
    service = new AgentNotificationService({
      observer,
      sessionStore,
      notifier: { native }
    });
    service.attach();
  });

  afterEach(() => {
    service.dispose();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('shows a native notification when a session needs approval', async () => {
    const session = await sessionStore.create({
      kind: 'codex',
      name: 'Codex',
      cwd: '/repo',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      resumeMode: 'new'
    });

    observer.registerTuiSession(session);
    observer.setTuiObservedState(session.id, 'working', 'thinking');
    observer.setTuiObservedState(session.id, 'waiting_for_approval', 'waiting for approval');
    await flushAsyncNotifications();

    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith({
      title: 'Codex needs approval',
      body: 'Codex: waiting for approval'
    });
  });

  it('does not repeat native notifications for duplicate snapshots', async () => {
    const session = await sessionStore.create({
      kind: 'codex',
      name: 'Codex',
      cwd: '/repo',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      resumeMode: 'new'
    });

    observer.registerTuiSession(session);
    observer.setTuiObservedState(session.id, 'waiting_for_approval', 'waiting for approval');
    observer.setTuiObservedState(session.id, 'waiting_for_approval', 'waiting for approval');
    await flushAsyncNotifications();

    expect(native).toHaveBeenCalledTimes(1);
  });
});

function flushAsyncNotifications(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
