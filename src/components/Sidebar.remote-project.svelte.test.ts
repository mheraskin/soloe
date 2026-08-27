/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { MultiDeviceSessionState } from '@shared/types/multi-device-sessions.js';
import { deviceSessions } from '../stores/device-sessions.svelte';
import Sidebar from './Sidebar.svelte';

const originalState = $state.snapshot(deviceSessions.state);
const originalLoaded = deviceSessions.loaded;
const originalRefreshing = deviceSessions.refreshing;
const originalDeviceFilter = deviceSessions.selectedDeviceId;
const originalVisibility = document.visibilityState;
let mounted: ReturnType<typeof mount> | null = null;

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
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
});

function setVisibility(state: DocumentVisibilityState, emit = true): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  });
  if (emit) document.dispatchEvent(new Event('visibilitychange'));
}

function remoteProjectState(): MultiDeviceSessionState {
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
      workspaces: []
    }],
    unassigned: [],
    archivedSessions: []
  };
}
