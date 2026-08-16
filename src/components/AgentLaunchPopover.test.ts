/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount, type Component } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
  createAgentWithDefaults: vi.fn(async () => undefined),
  createPreferredWithDefaults: vi.fn(async () => undefined),
  createWithDefaults: vi.fn(async () => undefined),
  reorder: vi.fn(async () => undefined)
}));

const deviceSessionMocks = vi.hoisted(() => ({
  reorder: vi.fn(async () => undefined),
  openSession: vi.fn(async () => undefined),
  stopSession: vi.fn(async () => undefined),
  restartSession: vi.fn(async () => undefined)
}));

vi.mock('../stores/sessions.svelte', () => ({
  sessions: {
    ...sessionMocks,
    selectedId: null,
    sessions: [],
    runtime: {},
    statusFor: vi.fn(() => 'idle'),
    observationFor: vi.fn(() => null),
    eventsFor: vi.fn(() => []),
    childWorkersFor: vi.fn(() => [])
  }
}));

vi.mock('../stores/device-sessions.svelte', () => ({
  deviceSessions: {
    ...deviceSessionMocks,
    device: vi.fn(() => ({ local: false, available: true })),
    isSelected: vi.fn(() => false)
  }
}));

vi.mock('../stores/agent-notifications.svelte', () => ({
  agentNotifications: {
    markerFor: vi.fn(() => null),
    pulsingSessionId: null
  }
}));

vi.mock('../stores/settings.svelte', () => ({
  settings: {
    current: {
      quickLaunch: [],
      shortcuts: { shiftNumberNavigation: 'off' }
    }
  }
}));

vi.mock('../stores/nav.svelte', () => ({
  nav: { worktreeIndexHints: {}, sessionIndexHints: {} }
}));

vi.mock('../stores/git.svelte', () => ({
  git: { shortstatFor: () => null }
}));

vi.mock('../stores/sidebar-expansion.svelte', () => ({
  sidebarExpansion: {
    isExpanded: () => true,
    setExpanded: vi.fn()
  }
}));

vi.mock('../stores/toast.svelte', () => ({
  reportError: vi.fn()
}));

import { dnd } from '../stores/dnd.svelte';
import AgentLaunchPopover from './AgentLaunchPopover.svelte';
import WorktreeGroup from './WorktreeGroup.svelte';

type MountedComponent = ReturnType<typeof mount>;

let mounted: MountedComponent[] = [];

function mountComponent<T extends Record<string, unknown>>(
  component: Component<T>,
  props: T
): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
}

function pointerEvent(
  type: string,
  init: { pointerId: number; pointerType: string; clientX: number; clientY: number }
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType },
    isPrimary: { value: true },
    button: { value: 0 },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY }
  });
  return event;
}

function dragEvent(type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: 'none',
      setData: vi.fn()
    }
  });
  return event;
}

describe('AgentLaunchPopover touch gestures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    for (const mock of Object.values(sessionMocks)) mock.mockClear();
    for (const mock of Object.values(deviceSessionMocks)) mock.mockClear();
  });

  afterEach(async () => {
    for (const component of mounted.splice(0)) await unmount(component);
    dnd.end();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('opens on touch hold and launches the option selected by sliding before release', async () => {
    const target = mountComponent(AgentLaunchPopover, {});
    const trigger = target.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    expect(trigger).not.toBeNull();

    trigger!.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 20,
      clientY: 20
    }));
    await vi.advanceTimersByTimeAsync(400);
    flushSync();

    const terminal = document.body.querySelector<HTMLButtonElement>('[aria-label="New terminal"]');
    expect(terminal).not.toBeNull();

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => terminal)
    });
    trigger!.dispatchEvent(pointerEvent('pointermove', {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 20,
      clientY: 90
    }));
    flushSync();
    expect(terminal?.dataset.gestureSelected).toBe('true');

    trigger!.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 20,
      clientY: 90
    }));
    terminal!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(sessionMocks.createWithDefaults).toHaveBeenCalledOnce();
    expect(sessionMocks.createPreferredWithDefaults).not.toHaveBeenCalled();
  });

  it('keeps an ordinary touch tap as the immediate preferred-session action', async () => {
    const target = mountComponent(AgentLaunchPopover, {});
    const trigger = target.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    expect(trigger).not.toBeNull();

    trigger!.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 9,
      pointerType: 'touch',
      clientX: 20,
      clientY: 20
    }));
    trigger!.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 9,
      pointerType: 'touch',
      clientX: 20,
      clientY: 20
    }));
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(400);
    flushSync();

    expect(sessionMocks.createPreferredWithDefaults).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[aria-label="New terminal"]')).toBeNull();
  });

  it('does not let the worktree drag handler claim a gesture that starts on plus', () => {
    const onWorktreeDrop = vi.fn();
    const target = mountComponent(WorktreeGroup, {
      title: 'feature/mobile',
      cwd: '/repo-mobile',
      projectId: 'project-1',
      items: [],
      onWorktreeDrop
    });
    const trigger = target.querySelector<HTMLButtonElement>(
      '[aria-label="New session in this worktree"]'
    );
    const worktreeDragSource = target.querySelector<HTMLElement>(
      '[aria-label="Toggle worktree feature/mobile"]'
    );
    expect(trigger).not.toBeNull();
    expect(worktreeDragSource?.draggable).toBe(true);
    expect(trigger?.closest('[draggable="true"]')).toBeNull();

    trigger!.dispatchEvent(dragEvent('dragstart'));

    expect(dnd.drag).toBeNull();
    expect(onWorktreeDrop).not.toHaveBeenCalled();
  });

  it('keeps a remote Session projection draggable through the existing Session row', () => {
    const remoteSession = {
      id: 'remote-session',
      name: 'Remote agent',
      cwd: '/repo-mobile',
      runMode: 'macos',
      launch: { type: 'terminal', shell: 'auto' },
      createdAt: '2026-08-14T20:00:00.000Z',
      lastUsedAt: '2026-08-14T20:00:00.000Z'
    } as const;
    const secondSession = {
      ...remoteSession,
      id: 'second-remote-session',
      name: 'Second remote agent'
    };
    const projection = {
      ref: { deviceId: 'remote-device', sessionId: remoteSession.id },
      key: 'remote-device/remote-session',
      deviceName: 'Remote Mac',
      available: true,
      session: remoteSession,
      runtime: null
    };
    const secondProjection = {
      ...projection,
      ref: { deviceId: 'remote-device', sessionId: secondSession.id },
      key: 'remote-device/second-remote-session',
      session: secondSession
    };
    const target = mountComponent(WorktreeGroup, {
      title: 'feature/mobile',
      cwd: '/repo-mobile',
      projectId: null,
      items: [remoteSession, secondSession],
      projections: [projection, secondProjection],
      allowLocalActions: false
    });
    const row = target.querySelector<HTMLElement>(`[data-session-id="${projection.key}"]`);

    expect(row?.draggable).toBe(true);
    row!.dispatchEvent(dragEvent('dragstart'));

    expect(dnd.drag).toMatchObject({
      kind: 'session',
      id: projection.key,
      projectId: null,
      worktreeCwd: '/repo-mobile'
    });

    const secondRow = target.querySelector<HTMLElement>(
      `[data-session-id="${secondProjection.key}"]`
    );
    secondRow!.dispatchEvent(dragEvent('drop'));

    expect(deviceSessionMocks.reorder).toHaveBeenCalledWith([
      secondProjection,
      projection
    ]);
  });

  it('keeps lifecycle actions in the existing context menu for a remote Session row', () => {
    const remoteSession = {
      id: 'remote-session',
      name: 'Remote agent',
      cwd: '/repo-mobile',
      runMode: 'linux',
      launch: { type: 'terminal', shell: 'auto' },
      createdAt: '2026-08-14T20:00:00.000Z',
      lastUsedAt: '2026-08-14T20:00:00.000Z'
    } as const;
    const projection = {
      ref: { deviceId: 'remote-device', sessionId: remoteSession.id },
      key: 'remote-device/remote-session',
      deviceName: 'Remote Linux',
      available: true,
      session: remoteSession,
      runtime: null
    };
    const target = mountComponent(WorktreeGroup, {
      title: 'feature/mobile',
      cwd: '/repo-mobile',
      projectId: null,
      items: [remoteSession],
      projections: [projection],
      allowLocalActions: false
    });
    const row = target.querySelector<HTMLElement>(`[data-session-id="${projection.key}"]`);

    expect(row?.outerHTML).toContain('data-context-menu-trigger');
  });
});
