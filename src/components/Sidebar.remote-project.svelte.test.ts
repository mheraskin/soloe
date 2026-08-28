/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  MultiDeviceSessionState,
  MultiDeviceSessionView
} from '@shared/types/multi-device-sessions.js';
import { deviceSessions } from '../stores/device-sessions.svelte';
import { sidebarExpansion } from '../stores/sidebar-expansion.svelte';
import Sidebar from './Sidebar.svelte';

const WORKTREE_CWD = '/home/mhera/work/saas-platform';
const originalState = $state.snapshot(deviceSessions.state);
const originalLoaded = deviceSessions.loaded;
const originalRefreshing = deviceSessions.refreshing;
const originalDeviceFilter = deviceSessions.selectedDeviceId;
const originalVisibility = document.visibilityState;
const originalWorktreeExpanded = sidebarExpansion.isExpanded(WORKTREE_CWD);
let mounted: ReturnType<typeof mount> | null = null;

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('CSS', {
    escape: (value: string) => value.replaceAll('"', '\\"')
  });
});

afterAll(() => vi.unstubAllGlobals());

describe('Sidebar remote Projects', () => {
  afterEach(async () => {
    if (mounted) await unmount(mounted);
    mounted = null;
    document.body.innerHTML = '';
    deviceSessions.state = structuredClone(originalState);
    deviceSessions.loaded = originalLoaded;
    deviceSessions.refreshing = originalRefreshing;
    deviceSessions.selectedDeviceId = originalDeviceFilter;
    deviceSessions.clearSelectedSession();
    sidebarExpansion.setExpanded(WORKTREE_CWD, originalWorktreeExpanded);
    setVisibility(originalVisibility, false);
    vi.restoreAllMocks();
  });

  it('renders a Project reported by a remote Device even without local Projects', () => {
    deviceSessions.state = remoteProjectState();
    deviceSessions.loaded = true;
    deviceSessions.selectedDeviceId = null;

    const target = document.createElement('div');
    document.body.append(target);
    mounted = mount(Sidebar, { target });
    flushSync();

    expect(target.querySelector('[data-project-id="saas-platform"]')).not.toBeNull();
    expect(target.textContent).toContain('saas-platform');
    expect(target.textContent).toContain('~/work/saas-platform');
  });

  it('refreshes Devices as soon as the sidebar becomes visible after sleep', () => {
    deviceSessions.state = remoteProjectState();
    deviceSessions.loaded = true;
    const refresh = vi.spyOn(deviceSessions, 'refresh').mockResolvedValue(undefined);

    const target = document.createElement('div');
    document.body.append(target);
    mounted = mount(Sidebar, { target });
    flushSync();

    setVisibility('hidden');
    expect(refresh).not.toHaveBeenCalled();
    setVisibility('visible');

    expect(refresh).toHaveBeenCalledOnce();
  });

  it('shows refresh progress without hiding cached remote Sessions', () => {
    deviceSessions.state = remoteProjectState();
    deviceSessions.loaded = true;
    deviceSessions.refreshing = true;

    const target = document.createElement('div');
    document.body.append(target);
    mounted = mount(Sidebar, { target });
    flushSync();

    expect(target.querySelector('[role="status"]')?.textContent).toContain('Refreshing Devices');
    expect(target.querySelector('[data-project-id="saas-platform"]')).not.toBeNull();
  });

  it('expands and scrolls to a Session created from a collapsed Worktree', async () => {
    const existing = remoteSession('existing-session', 'Existing Session');
    const created = remoteSession('created-session', 'Created Session');
    deviceSessions.state = remoteProjectState([existing]);
    deviceSessions.loaded = true;
    deviceSessions.selectedDeviceId = null;
    deviceSessions.clearSelectedSession();
    sidebarExpansion.setExpanded(WORKTREE_CWD, false);
    const setExpanded = vi.spyOn(sidebarExpansion, 'setExpanded');
    vi.spyOn(deviceSessions, 'refresh').mockResolvedValue(undefined);
    vi.spyOn(deviceSessions, 'planCreate').mockResolvedValue({
      planId: 'plan-created-session',
      workspaceKey: 'workspace-main',
      targetDeviceId: 'device-xps',
      deviceName: 'xps',
      action: 'use-existing-location',
      targetPath: WORKTREE_CWD,
      executable: true,
      blockers: [],
      warnings: [],
      expiresAt: '2099-01-01T00:00:00.000Z'
    });
    const executeCreate = vi.spyOn(deviceSessions, 'executeCreate').mockImplementation(async () => {
      const next = structuredClone($state.snapshot(deviceSessions.state));
      next.revision += 1;
      next.projects[0]!.workspaces[0]!.sessions.push(created);
      deviceSessions.state = next;
      deviceSessions.selectSession(created.key);
      return created;
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    const target = document.createElement('div');
    document.body.append(target);
    mounted = mount(Sidebar, { target });
    flushSync();

    const viewport = target.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this === viewport) return testRect(0, 120);
      if (this.getAttribute('data-session-id') === created.key) {
        const expanded = target.querySelector('[aria-label="Toggle worktree main"]')
          ?.getAttribute('aria-expanded') === 'true';
        return expanded ? testRect(240, 280) : testRect(0, 0);
      }
      return testRect(0, 20);
    });

    const worktreeToggle = target.querySelector<HTMLElement>(
      '[aria-label="Toggle worktree main"]'
    )!;
    expect(worktreeToggle.getAttribute('aria-expanded')).toBe('false');
    target.querySelector<HTMLButtonElement>('[aria-label="New session in this worktree"]')!
      .click();
    flushSync();
    document.body.querySelector<HTMLButtonElement>('[aria-label="New terminal"]')!.click();

    await vi.waitFor(() => expect(executeCreate).toHaveBeenCalledWith('plan-created-session'));
    await vi.waitFor(() => expect(setExpanded).toHaveBeenCalledWith(WORKTREE_CWD, true));
    await vi.waitFor(() => expect(
      target.querySelector('[aria-label="Toggle worktree main"]')?.getAttribute('aria-expanded')
    ).toBe('true'));
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({
      top: expect.any(Number),
      behavior: 'smooth'
    })));
  });
});

function setVisibility(state: DocumentVisibilityState, emit = true): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  });
  if (emit) document.dispatchEvent(new Event('visibilitychange'));
}

function remoteProjectState(sessions: MultiDeviceSessionView[] = []): MultiDeviceSessionState {
  return {
    revision: 1,
    capturedAt: '2026-08-25T00:00:00.000Z',
    devices: [{
      deviceId: 'device-xps',
      name: 'xps',
      state: 'ready',
      available: true,
      local: false,
      platform: 'linux'
    }],
    projects: [{
      key: 'git:saas-platform',
      name: 'saas-platform',
      repository: {
        kind: 'git',
        canonicalUrl: 'git@github.com:example/saas-platform.git'
      },
      presences: [{
        ref: { deviceId: 'device-xps', projectId: 'saas-platform' },
        key: 'device-xps/saas-platform',
        deviceName: 'xps',
        available: true,
        project: {
          id: 'saas-platform',
          name: 'saas-platform',
          path: '/home/mhera/work/saas-platform',
          defaultRunMode: 'linux',
          createdAt: '2026-08-25T00:00:00.000Z',
          lastOpenedAt: '2026-08-25T00:00:00.000Z'
        }
      }],
      workspaces: sessions.length > 0 ? [{
        key: 'workspace-main',
        name: 'main',
        branch: 'main',
        locations: [{
          key: `device-xps:${WORKTREE_CWD}`,
          deviceId: 'device-xps',
          deviceName: 'xps',
          projectId: 'saas-platform',
          path: WORKTREE_CWD,
          available: true,
          isMain: true
        }],
        sessions
      }] : []
    }],
    unassigned: [],
    archivedSessions: []
  };
}

function remoteSession(id: string, name: string): MultiDeviceSessionView {
  return {
    ref: { deviceId: 'device-xps', sessionId: id },
    key: `device-xps/${id}`,
    deviceName: 'xps',
    available: true,
    session: {
      id,
      name,
      cwd: WORKTREE_CWD,
      projectId: 'saas-platform',
      runMode: 'linux',
      launch: { type: 'terminal', shell: 'auto' },
      createdAt: '2026-08-25T00:00:00.000Z',
      lastUsedAt: '2026-08-25T00:00:00.000Z',
      lastBranch: 'main'
    },
    lifecycleStatus: 'running',
    runtime: {
      sessionId: id,
      terminalId: `terminal-${id}`,
      status: 'running'
    },
    observation: null
  };
}

function testRect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 280,
    bottom,
    left: 0,
    width: 280,
    height: bottom - top,
    toJSON: () => ({})
  };
}
