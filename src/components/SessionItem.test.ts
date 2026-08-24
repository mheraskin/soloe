/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openSession: vi.fn(async () => undefined),
  selectSession: vi.fn(),
  selectLocalSession: vi.fn(),
  startLocalSession: vi.fn(async () => undefined),
  pendingOperation: vi.fn((): string | null => null),
  rightRail: { fullscreen: true }
}));

vi.mock('../stores/sessions.svelte', () => ({
  sessions: {
    selectedId: null,
    runtime: {},
    statusFor: vi.fn(() => 'stopped'),
    observationFor: vi.fn(() => null),
    eventsFor: vi.fn(() => []),
    childWorkersFor: vi.fn(() => []),
    select: mocks.selectLocalSession,
    start: mocks.startLocalSession,
    update: vi.fn(),
    remove: vi.fn(),
    isInActiveSplit: vi.fn(() => false),
    canAddToSplit: vi.fn(() => false),
    addToSplit: vi.fn(),
    removeFromSplit: vi.fn()
  }
}));
vi.mock('../stores/device-sessions.svelte', () => ({
  deviceSessions: {
    device: vi.fn(() => ({ local: false, available: true })),
    isSelected: vi.fn(() => false),
    pendingOperation: mocks.pendingOperation,
    openSession: mocks.openSession,
    selectSession: mocks.selectSession,
    clearSelectedSession: vi.fn(),
    stopSession: vi.fn(),
    restartSession: vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
    previewCommand: vi.fn()
  }
}));
vi.mock('../stores/agent-notifications.svelte', () => ({
  agentNotifications: {
    markerFor: vi.fn(() => null),
    pulsingSessionId: null
  }
}));
vi.mock('../stores/nav.svelte', () => ({ nav: { sessionIndexHints: {} } }));
vi.mock('../stores/session-context-menus.svelte', () => ({
  sessionContextMenus: { onCloseAll: vi.fn(() => () => undefined) }
}));
vi.mock('../stores/session-handoff.svelte', () => ({ sessionHandoff: { open: vi.fn() } }));
vi.mock('../stores/modal.svelte', () => ({ modal: { openEdit: vi.fn() } }));
vi.mock('../stores/right-rail.svelte', () => ({ rightRail: mocks.rightRail }));
vi.mock('../stores/toast.svelte', () => ({ reportError: vi.fn() }));
vi.mock('../lib/ipc', () => ({
  ipc: { system: { openPath: vi.fn() }, sessions: { previewCommand: vi.fn() } }
}));
vi.mock('../lib/session-delete-confirmation', () => ({
  confirmDeleteSession: vi.fn(async () => true)
}));

import SessionItem from './SessionItem.svelte';

describe('SessionItem lifecycle', () => {
  let mounted: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mocks.pendingOperation.mockReturnValue(null);
    mocks.rightRail.fullscreen = true;
  });

  it.each(['stopped', 'exited'] as const)(
    'opens a %s remote Session while preserving its intended status presentation',
    (lifecycleStatus) => {
      const target = document.createElement('div');
      document.body.append(target);
      mounted = mount(SessionItem, {
        target,
        props: {
          session: {
            id: 'session-1',
            name: 'Remote Codex',
            cwd: '/home/dev/soloe',
            runMode: 'linux',
            launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
            createdAt: '2026-08-16T00:00:00.000Z',
            lastUsedAt: '2026-08-16T00:00:00.000Z'
          },
          projection: {
            ref: { deviceId: 'device-xps', sessionId: 'session-1' },
            key: 'device-xps/session-1',
            deviceName: 'xps',
            available: true,
            session: {
              id: 'session-1',
              name: 'Remote Codex',
              cwd: '/home/dev/soloe',
              runMode: 'linux',
              launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
              createdAt: '2026-08-16T00:00:00.000Z',
              lastUsedAt: '2026-08-16T00:00:00.000Z'
            },
            lifecycleStatus,
            runtime: null,
            observation: null
          },
          showDevice: true
        }
      });
      flushSync();

      target.querySelector<HTMLElement>('[data-session-id="device-xps/session-1"]')?.click();

      expect(mocks.openSession).toHaveBeenCalledWith('device-xps/session-1');
      expect(mocks.selectSession).not.toHaveBeenCalled();
      expect(target.querySelector('[aria-label="stopped"]')).toBeNull();
      if (lifecycleStatus === 'exited') {
        expect(target.querySelector('[aria-label="exited"]')).not.toBeNull();
      } else {
        expect(target.querySelector('[aria-label="exited"]')).toBeNull();
      }
    }
  );

  it('starts a stopped local Session when its row is clicked', () => {
    const target = document.createElement('div');
    document.body.append(target);
    mounted = mount(SessionItem, {
      target,
      props: {
        session: {
          id: 'session-local',
          name: 'Local Codex',
          cwd: '/Users/dev/soloe',
          runMode: 'macos',
          launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
          createdAt: '2026-08-16T00:00:00.000Z',
          lastUsedAt: '2026-08-16T00:00:00.000Z'
        }
      }
    });
    flushSync();

    target.querySelector<HTMLElement>('[data-session-id="session-local"]')?.click();

    expect(mocks.selectLocalSession).toHaveBeenCalledWith('session-local');
    expect(mocks.startLocalSession).toHaveBeenCalledWith('session-local');
  });

  it('activates a running remote Session through the same restoration path as Resume', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const session = {
      id: 'session-running',
      name: 'Remote Codex',
      cwd: '/home/dev/soloe',
      runMode: 'linux' as const,
      launch: { type: 'agent' as const, provider: 'codex' as const, resumeMode: 'new' as const },
      createdAt: '2026-08-16T00:00:00.000Z',
      lastUsedAt: '2026-08-16T00:00:00.000Z'
    };
    mounted = mount(SessionItem, {
      target,
      props: {
        session,
        projection: {
          ref: { deviceId: 'device-xps', sessionId: session.id },
          key: `device-xps/${session.id}`,
          deviceName: 'xps',
          available: true,
          session,
          lifecycleStatus: 'running',
          runtime: {
            sessionId: session.id,
            terminalId: 'terminal-running',
            status: 'running'
          },
          observation: null
        }
      }
    });
    flushSync();

    target.querySelector<HTMLElement>(`[data-session-id="device-xps/${session.id}"]`)?.click();

    expect(mocks.openSession).toHaveBeenCalledWith(`device-xps/${session.id}`);
    expect(mocks.selectSession).not.toHaveBeenCalled();
    expect(mocks.rightRail.fullscreen).toBe(false);
  });

  it('shows and locks a remote Session row while deletion is pending', () => {
    mocks.pendingOperation.mockReturnValue('deleting');
    const target = document.createElement('div');
    document.body.append(target);
    const session = {
      id: 'session-deleting',
      name: 'Remote Claude',
      cwd: '/home/dev/soloe',
      runMode: 'linux' as const,
      launch: { type: 'agent' as const, provider: 'claude_code' as const, resumeMode: 'new' as const },
      createdAt: '2026-08-16T00:00:00.000Z',
      lastUsedAt: '2026-08-16T00:00:00.000Z'
    };
    mounted = mount(SessionItem, {
      target,
      props: {
        session,
        projection: {
          ref: { deviceId: 'device-xps', sessionId: session.id },
          key: `device-xps/${session.id}`,
          deviceName: 'xps',
          available: true,
          session,
          lifecycleStatus: 'running',
          runtime: {
            sessionId: session.id,
            terminalId: 'terminal-deleting',
            status: 'running'
          },
          observation: null
        }
      }
    });
    flushSync();

    const row = target.querySelector<HTMLElement>(`[data-session-id="device-xps/${session.id}"]`)!;
    const deleteButton = target.querySelector<HTMLButtonElement>(`[aria-label="Deleting ${session.name}"]`)!;
    row.click();

    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(target.querySelector('[aria-label="Deleting"]')).not.toBeNull();
    expect(deleteButton.disabled).toBe(true);
    expect(mocks.openSession).not.toHaveBeenCalled();
  });
});
