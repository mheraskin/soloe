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
  restartSession: vi.fn(async () => undefined),
  updateSession: vi.fn(async () => undefined),
  clearSelectedSession: vi.fn(),
  isSelected: vi.fn(() => false),
  pendingOperation: vi.fn(() => null),
  refresh: vi.fn(async () => undefined),
  planCreate: vi.fn(async () => ({
    planId: 'plan-1',
    workspaceKey: null,
    targetDeviceId: 'local-device',
    deviceName: 'This Mac',
    action: 'use-device-directory',
    targetPath: '~',
    executable: true,
    blockers: [],
    warnings: [],
    expiresAt: '2099-01-01T00:00:00.000Z'
  })),
  executeCreate: vi.fn(async () => undefined),
  loadModelCatalog: vi.fn(async (deviceId: string) => deviceSessionState.modelCatalogs[deviceId] ?? []),
  modelCatalogForDevice: vi.fn((deviceId?: string | null) => deviceSessionState.modelCatalogs[deviceId ?? ''] ?? null)
}));

const deviceSessionState = vi.hoisted(() => ({
  multiDeviceActive: true,
  projects: [] as Array<Record<string, unknown>>,
  modelCatalogs: {} as Record<string, import('@shared/types/settings.js').ModelCatalogEntry[]>
}));

const commandPaletteMocks = vi.hoisted(() => ({
  openProject: vi.fn()
}));

const worktreeCreateMocks = vi.hoisted(() => ({
  openFor: vi.fn()
}));

vi.mock('../stores/command-palette.svelte', () => ({
  commandPalette: commandPaletteMocks
}));

vi.mock('../stores/projects.svelte', () => ({
  projects: { get: vi.fn(() => null) }
}));

vi.mock('../stores/worktree-create-modal.svelte', () => ({
  worktreeCreateModal: worktreeCreateMocks
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
    supported: true,
    get multiDeviceActive() {
      return deviceSessionState.multiDeviceActive;
    },
    state: {
      devices: [
        {
          deviceId: 'local-device',
          name: 'This Mac',
          local: true,
          available: true,
          state: 'ready'
        },
        {
          deviceId: 'remote-device',
          name: 'Remote Device',
          local: false,
          available: true,
          state: 'ready'
        }
      ],
      get projects() {
        return deviceSessionState.projects;
      },
      capturedAt: '2026-08-28T09:00:00.000Z'
    },
    visibleDevices: [
      {
        deviceId: 'local-device',
        name: 'This Mac',
        local: true,
        available: true,
        state: 'ready'
      },
      {
        deviceId: 'remote-device',
        name: 'Remote Device',
        local: false,
        available: true,
        state: 'ready'
      }
    ],
    localDevice: {
      deviceId: 'local-device',
      name: 'This Mac',
      local: true,
      available: true,
      state: 'ready'
    },
    device: vi.fn((deviceId: string) => deviceId === 'local-device'
      ? {
          deviceId: 'local-device',
          name: 'This Mac',
          local: true,
          available: true,
          state: 'ready'
        }
      : {
          deviceId,
          name: 'Remote Device',
          local: false,
          available: true,
          state: 'ready'
        })
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
      defaults: { newSessionKind: 'codex', shell: 'auto' },
      shortcuts: { shiftNumberNavigation: 'off' }
    },
    update: vi.fn(async () => undefined)
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
import { settings } from '../stores/settings.svelte';
import { PROVIDER_RAIL_ORDER_KEY } from '../lib/provider-rail-order';
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
    ctrlKey: { value: false },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY }
  });
  return event;
}

function dragEvent(
  type: string,
  init: { clientX?: number; clientY?: number } = {}
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: {
      value: {
        effectAllowed: 'none',
        dropEffect: 'none',
        setData: vi.fn()
      }
    },
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 }
  });
  return event;
}

describe('AgentLaunchPopover touch gestures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(pointer: fine)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    });
    for (const mock of Object.values(sessionMocks)) mock.mockClear();
    for (const mock of Object.values(deviceSessionMocks)) mock.mockClear();
    (settings.update as ReturnType<typeof vi.fn>).mockClear();
    deviceSessionMocks.isSelected.mockReturnValue(false);
    deviceSessionState.multiDeviceActive = true;
    deviceSessionState.projects = [];
    deviceSessionState.modelCatalogs = {};
    commandPaletteMocks.openProject.mockClear();
    worktreeCreateMocks.openFor.mockClear();
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
    await vi.waitFor(() => expect(deviceSessionMocks.executeCreate).toHaveBeenCalledWith('plan-1'));
    expect(deviceSessionMocks.planCreate).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKey: null,
      targetDeviceId: 'local-device',
      session: expect.objectContaining({ launch: { type: 'terminal', shell: 'auto' } })
    }));
    expect(sessionMocks.createWithDefaults).not.toHaveBeenCalled();
    expect(sessionMocks.createPreferredWithDefaults).not.toHaveBeenCalled();
  });

  it('opens the shared placement setup on an ordinary touch tap', async () => {
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

    expect(sessionMocks.createPreferredWithDefaults).not.toHaveBeenCalled();
    expect(document.body.querySelector('[aria-label="New terminal"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Run on device');
    expect(document.body.textContent).toContain('No project');
  });

  it('keeps a compact provider rail independent from placement and Quick Launch', () => {
    const target = mountComponent(AgentLaunchPopover, {});
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const providerRail = document.body.querySelector<HTMLElement>('[data-slot="provider-rail"]');
    const railColumn = document.body.querySelector<HTMLElement>('[data-slot="provider-rail-column"]');
    const separator = document.body.querySelector<HTMLElement>('[data-slot="provider-rail-separator"]');
    const quickLaunch = document.body.querySelector<HTMLElement>('[data-slot="quick-launch-strip"]');
    const terminal = document.body.querySelector<HTMLButtonElement>('[aria-label="New terminal"]');
    expect(providerRail).not.toBeNull();
    expect(providerRail?.className).toContain('overflow-y-auto');
    expect(railColumn?.className).toContain('max-h-[13.5rem]');
    expect(separator).not.toBeNull();
    expect(quickLaunch).not.toBeNull();
    expect(quickLaunch?.className).toContain('overflow-x-auto');
    expect(terminal).not.toBeNull();
    expect(railColumn?.contains(terminal!)).toBe(true);
    expect(quickLaunch?.contains(terminal!)).toBe(false);
    expect(document.body.querySelector('[data-slot="model-browser"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Search models"]')).toBeNull();
    expect(document.body.textContent).toContain('Run on device');
  });

  it('reorders agent providers with HTML5 drag and drop on fine pointers', () => {
    const target = mountComponent(AgentLaunchPopover, {});
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const opencode = document.body.querySelector<HTMLButtonElement>('[aria-label="New OpenCode session"]');
    const claude = document.body.querySelector<HTMLButtonElement>('[aria-label="New Claude session"]');
    expect(opencode?.draggable).toBe(true);
    expect(claude).not.toBeNull();
    Object.defineProperty(claude!, 'getBoundingClientRect', {
      value: () => ({ top: 40, left: 0, height: 44, width: 44, bottom: 84, right: 44, x: 0, y: 40, toJSON() {} })
    });

    opencode!.dispatchEvent(dragEvent('dragstart'));
    claude!.dispatchEvent(dragEvent('dragover', { clientY: 70 }));
    claude!.dispatchEvent(dragEvent('drop', { clientY: 70 }));
    flushSync();

    const railButtons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[data-slot="provider-rail"] [data-launch-option]')
    ).map((button) => button.dataset.launchOption);
    expect(railButtons[0]).toBe('grok_build');
    expect(railButtons).toContain('opencode');
    expect(JSON.parse(localStorage.getItem(PROVIDER_RAIL_ORDER_KEY) ?? '[]')).toContain('opencode');
    expect(document.body.querySelector<HTMLElement>('[aria-label="New terminal"]')?.draggable).not.toBe(true);
  });

  it('does not enable provider drag handles on coarse pointers', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));
    const target = mountComponent(AgentLaunchPopover, {});
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const claude = document.body.querySelector<HTMLButtonElement>('[aria-label="New Claude session"]');
    expect(claude?.draggable).toBe(false);
  });

  it('launches a provider directly from the left rail', async () => {
    const target = mountComponent(AgentLaunchPopover, {});
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    document.body.querySelector<HTMLButtonElement>('[aria-label="New Claude session"]')!.click();

    await vi.waitFor(() => expect(deviceSessionMocks.planCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: 'local-device',
        session: expect.objectContaining({
          launch: expect.objectContaining({
            type: 'agent',
            provider: 'claude_code'
          })
        })
      })
    ));
  });

  it('launches directly from the provider rail on the local Session path', async () => {
    deviceSessionState.multiDeviceActive = false;
    const target = mountComponent(AgentLaunchPopover, {});
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    document.body.querySelector<HTMLButtonElement>('[aria-label="New Claude session"]')!.click();

    await vi.waitFor(() => expect(sessionMocks.createAgentWithDefaults).toHaveBeenCalledWith(
      'claude_code',
      expect.any(Object)
    ));
    expect(deviceSessionMocks.planCreate).not.toHaveBeenCalled();
  });

  it('refreshes the shared Device state as soon as the popover opens', async () => {
    const target = mountComponent(AgentLaunchPopover, {});
    const trigger = target.querySelector<HTMLButtonElement>('[aria-label="New session"]');

    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(deviceSessionMocks.refresh).toHaveBeenCalledWith({
      background: true
    }));

    expect(document.body.querySelector('[aria-label="Choose device"]')).not.toBeNull();
  });

  it('reports the created Session row after a Device launch completes', async () => {
    const onSessionCreated = vi.fn();
    deviceSessionMocks.executeCreate.mockImplementationOnce(async () => ({
      key: 'local-device/created-session'
    }) as never);
    const target = mountComponent(AgentLaunchPopover, { onSessionCreated });

    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();
    document.body.querySelector<HTMLButtonElement>('[aria-label="New terminal"]')!.click();

    await vi.waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith(
      'local-device/created-session'
    ));
  });

  it('defaults the global picker to no project when Workspaces are available', async () => {
    deviceSessionState.projects = [{
      key: 'project-soloe',
      name: 'Soloe',
      repository: { kind: 'git', canonicalUrl: 'https://example.test/soloe.git' },
      presences: [],
      workspaces: [{
        key: 'workspace-main',
        name: 'main',
        branch: 'main',
        locations: [{
          key: 'remote-device:/srv/soloe',
          deviceId: 'remote-device',
          deviceName: 'Remote Device',
          projectId: 'remote-project',
          path: '/srv/soloe',
          available: true,
          isMain: true
        }],
        sessions: []
      }]
    }];
    const target = mountComponent(AgentLaunchPopover, { level: 'global' });

    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(deviceSessionMocks.planCreate).toHaveBeenCalled());
    const worktreeTrigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Choose worktree"]'
    );
    expect(worktreeTrigger?.textContent).toContain('No project');
    expect(deviceSessionMocks.planCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceKey: null
    }));
    expect(document.body.textContent).not.toContain('No project · Device home folder');
    expect(document.body.textContent).not.toContain('Project is not initialized on this device');
    expect(document.body.textContent).not.toContain('Choose workspace location');
  });

  it('puts the Device-aware project action first and labels worktrees with their Devices', async () => {
    deviceSessionState.projects = [{
      key: 'project-soloe',
      name: 'Soloe',
      repository: { kind: 'git', canonicalUrl: 'https://example.test/soloe.git' },
      presences: [],
      workspaces: [{
        key: 'workspace-main',
        name: 'main',
        branch: 'main',
        locations: [{
          key: 'remote-device:/srv/soloe',
          deviceId: 'remote-device',
          deviceName: 'Remote Device',
          projectId: 'remote-project',
          path: '/srv/soloe',
          available: true,
          isMain: true
        }],
        sessions: []
      }]
    }];
    const target = mountComponent(AgentLaunchPopover, { level: 'global' });
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const worktreeTrigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Choose worktree"]'
    );
    worktreeTrigger!.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 21,
      pointerType: 'mouse',
      clientX: 100,
      clientY: 100
    }));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const worktreeMenu = document.body.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-content"]'
    );
    expect(worktreeMenu?.className).toContain('bg-card');
    expect(worktreeMenu?.className).toContain('w-(--bits-dropdown-menu-anchor-width)');
    expect(worktreeMenu?.className).not.toContain('w-80');
    expect(items[0]?.textContent).toContain('Open a project on This Mac');
    const workspaceItem = items.find((item) =>
      item.textContent?.includes('main') && item.textContent.includes('Soloe')
    );
    expect(workspaceItem?.querySelector('[data-slot="device-chip"]')?.textContent)
      .toContain('Remote Device');

    items[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(commandPaletteMocks.openProject).toHaveBeenCalledWith('local-device');
  });

  it('opens Device-aware worktree creation from a Project-level plus', async () => {
    const remoteProject = {
      id: 'remote-project',
      name: 'Soloe',
      path: '/srv/soloe',
      defaultRunMode: 'linux',
      createdAt: '2026-08-28T09:00:00.000Z',
      lastOpenedAt: '2026-08-28T09:00:00.000Z'
    };
    deviceSessionState.projects = [{
      key: 'project-soloe',
      name: 'Soloe',
      repository: { kind: 'git', canonicalUrl: 'https://example.test/soloe.git' },
      presences: [{
        ref: { deviceId: 'remote-device', projectId: remoteProject.id },
        key: 'remote-device:remote-project',
        deviceName: 'Remote Device',
        available: true,
        project: remoteProject
      }],
      workspaces: [{
        key: 'workspace-main',
        name: 'main',
        branch: 'main',
        locations: [{
          key: 'remote-device:/srv/soloe',
          deviceId: 'remote-device',
          deviceName: 'Remote Device',
          projectId: remoteProject.id,
          path: remoteProject.path,
          available: true,
          isMain: true
        }],
        sessions: []
      }]
    }];
    const target = mountComponent(AgentLaunchPopover, {
      level: 'project',
      projectKey: 'project-soloe',
      workspaceKey: 'workspace-main',
      defaultDeviceId: 'remote-device'
    });
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const worktreeTrigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Choose worktree"]'
    );
    expect(worktreeTrigger?.querySelector('[data-slot="device-chip"]')?.textContent)
      .toContain('Remote Device');
    worktreeTrigger!.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 22,
      pointerType: 'mouse',
      clientX: 100,
      clientY: 100
    }));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    const addWorktree = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Add worktree'));
    expect(addWorktree).toBeDefined();
    expect(addWorktree?.textContent).not.toContain('on Remote Device');
    expect(addWorktree?.querySelector('[data-slot="device-chip"]')?.textContent)
      .toContain('Remote Device');

    addWorktree!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(worktreeCreateMocks.openFor).toHaveBeenCalledWith(
      remoteProject,
      'main',
      { deviceId: 'remote-device', deviceName: 'Remote Device' }
    );
  });

  it('keeps the legacy local launch flow when no remote Device exists', async () => {
    deviceSessionState.multiDeviceActive = false;
    const target = mountComponent(AgentLaunchPopover, {});
    const trigger = target.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(deviceSessionMocks.refresh).toHaveBeenCalledOnce());

    expect(document.body.textContent).toContain('Run on device');
    const terminal = document.body.querySelector<HTMLButtonElement>('[aria-label="New terminal"]');
    terminal!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(sessionMocks.createWithDefaults).toHaveBeenCalledOnce());
    expect(deviceSessionMocks.planCreate).not.toHaveBeenCalled();
  });

  it('creates a Cursor Agent session through the shared device placement surface', async () => {
    const target = mountComponent(AgentLaunchPopover, {});
    const trigger = target.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();
    const cursor = document.body.querySelector<HTMLButtonElement>('[aria-label="New Cursor session"]');
    expect(cursor).not.toBeNull();
    cursor!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(deviceSessionMocks.planCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDeviceId: 'local-device',
        session: expect.objectContaining({
          name: 'Cursor',
          launch: {
            type: 'agent', provider: 'cursor', resumeMode: 'new', cursorMode: 'agent'
          }
        })
      })
    ));
  });

  it('keeps the workspace preview stable while a Session launch is in progress', async () => {
    const readyPlan = {
      planId: 'plan-ready',
      workspaceKey: null,
      targetDeviceId: 'local-device',
      deviceName: 'This Mac',
      action: 'use-existing-location' as const,
      targetPath: '/repo',
      executable: true,
      blockers: [],
      warnings: [],
      expiresAt: '2099-01-01T00:00:00.000Z'
    };
    let planCalls = 0;
    let resolveUnexpectedPreview: (() => void) | undefined;
    const unexpectedPreview = new Promise<typeof readyPlan>((resolve) => {
      resolveUnexpectedPreview = () => resolve(readyPlan);
    });
    let resolveExecution: (() => void) | undefined;
    const execution = new Promise<undefined>((resolve) => {
      resolveExecution = () => resolve(undefined);
    });
    deviceSessionMocks.planCreate.mockImplementation(async () => {
      planCalls += 1;
      if (planCalls <= 2) return readyPlan;
      return unexpectedPreview;
    });
    deviceSessionMocks.executeCreate.mockImplementation(() => execution);

    const target = mountComponent(AgentLaunchPopover, {
      level: 'worktree',
      workspaceKey: 'workspace-main'
    });
    const trigger = target.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Workspace ready'));
    deviceSessionMocks.planCreate.mockClear();

    document.body.querySelector<HTMLButtonElement>('[aria-label="New Codex session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(deviceSessionMocks.executeCreate).toHaveBeenCalledWith('plan-ready'));
    await Promise.resolve();
    flushSync();

    expect(deviceSessionMocks.planCreate).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Workspace ready');
    expect(document.body.textContent).not.toContain('Checking workspace…');

    resolveExecution?.();
    resolveUnexpectedPreview?.();
  });

  it('keeps the workspace card mounted while a Device replan is pending', async () => {
    const readyPlan = {
      planId: 'plan-ready',
      workspaceKey: null,
      targetDeviceId: 'local-device',
      deviceName: 'This Mac',
      action: 'use-existing-location' as const,
      targetPath: '/repo',
      executable: true,
      blockers: [],
      warnings: [],
      expiresAt: '2099-01-01T00:00:00.000Z'
    };
    deviceSessionMocks.planCreate.mockResolvedValue(readyPlan as never);
    const target = mountComponent(AgentLaunchPopover, {
      level: 'worktree',
      workspaceKey: 'workspace-main'
    });
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Workspace ready'));

    let resolveReplan: ((value: typeof readyPlan) => void) | undefined;
    deviceSessionMocks.planCreate.mockClear().mockReturnValueOnce(new Promise((resolve) => {
      resolveReplan = resolve;
    }) as never);
    const deviceTrigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Choose device"]'
    );
    Object.defineProperties(deviceTrigger!, {
      hasPointerCapture: { value: vi.fn(() => false) },
      releasePointerCapture: { value: vi.fn() }
    });
    deviceTrigger!.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 31,
      pointerType: 'mouse',
      clientX: 100,
      clientY: 100
    }));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    const remoteOption = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')
    ).find((item) => item.textContent?.includes('Remote Device'));
    expect(remoteOption).toBeDefined();
    remoteOption!.dispatchEvent(pointerEvent('pointerup', {
      pointerId: 31,
      pointerType: 'mouse',
      clientX: 100,
      clientY: 120
    }));
    await vi.waitFor(() => expect(deviceSessionMocks.planCreate).toHaveBeenCalled());
    flushSync();

    expect(document.body.querySelector('[data-slot="workspace-plan"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Workspace ready');
    expect(document.body.textContent).not.toContain('Checking workspace…');

    resolveReplan?.(readyPlan);
  });

  it('keeps the launch popover open while hovering the portalled Device menu', async () => {
    const target = mountComponent(AgentLaunchPopover, {});
    const trigger = target.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const deviceTrigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Choose device"]');
    expect(deviceTrigger).not.toBeNull();
    Object.defineProperties(deviceTrigger!, {
      hasPointerCapture: { value: vi.fn(() => false) },
      releasePointerCapture: { value: vi.fn() }
    });
    deviceTrigger!.dispatchEvent(pointerEvent('pointerdown', {
      pointerId: 12,
      pointerType: 'mouse',
      clientX: 100,
      clientY: 100
    }));
    await vi.advanceTimersByTimeAsync(0);
    flushSync();

    const popover = document.body.querySelector<HTMLElement>('[data-slot="popover-content"]');
    const deviceMenu = document.body.querySelector<HTMLElement>('[data-slot="select-content"]');
    expect(popover).not.toBeNull();
    expect(deviceMenu).not.toBeNull();
    expect(deviceMenu?.className).toContain('bg-card');
    expect(deviceMenu?.className).toContain('w-(--bits-select-anchor-width)');
    expect(deviceTrigger?.textContent).toContain('this device');

    popover!.dispatchEvent(pointerEvent('pointerleave', {
      pointerId: 12,
      pointerType: 'mouse',
      clientX: 110,
      clientY: 150
    }));
    deviceMenu!.dispatchEvent(pointerEvent('pointerenter', {
      pointerId: 12,
      pointerType: 'mouse',
      clientX: 110,
      clientY: 155
    }));
    await vi.advanceTimersByTimeAsync(250);
    flushSync();

    expect(document.body.querySelector('[aria-label="New terminal"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot="select-content"]')).not.toBeNull();
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

  it('keeps a selected remote Session open when Enter commits an inline rename', async () => {
    deviceSessionMocks.isSelected.mockReturnValue(true);
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
      runtime: {
        sessionId: remoteSession.id,
        terminalId: 'terminal-remote-session',
        status: 'running' as const
      }
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

    row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
    await Promise.resolve();
    flushSync();
    const input = row!.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    input!.value = 'Renamed remote agent';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    }));
    await Promise.resolve();
    flushSync();

    expect(deviceSessionMocks.updateSession).toHaveBeenCalledWith(projection.key, {
      name: 'Renamed remote agent',
      autoNamed: false
    });
    expect(deviceSessionMocks.clearSelectedSession).not.toHaveBeenCalled();
  });

  it('disables agent provider buttons that are not installed on the selected device in the dropdown', () => {
    deviceSessionState.modelCatalogs = {
      'remote-device': [{ provider: 'claude', id: 'sonnet', label: 'Claude 3.7 Sonnet' }]
    };

    const target = mountComponent(AgentLaunchPopover, { defaultDeviceId: 'remote-device' });
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const claude = document.body.querySelector<HTMLButtonElement>('[data-launch-option="claude_code"]');
    const codex = document.body.querySelector<HTMLButtonElement>('[data-launch-option="codex"]');
    const cursor = document.body.querySelector<HTMLButtonElement>('[data-launch-option="cursor"]');
    const opencode = document.body.querySelector<HTMLButtonElement>('[data-launch-option="opencode"]');
    const grok = document.body.querySelector<HTMLButtonElement>('[data-launch-option="grok_build"]');
    const terminal = document.body.querySelector<HTMLButtonElement>('[data-launch-option="terminal"]');

    expect(claude).not.toBeNull();
    expect(claude?.disabled).toBe(false);
    expect(claude?.getAttribute('aria-disabled')).toBeNull();
    expect(claude?.title).toBe('Claude');

    expect(codex).not.toBeNull();
    expect(codex?.disabled).toBe(true);
    expect(codex?.getAttribute('aria-disabled')).toBe('true');
    expect(codex?.title).toContain('Codex CLI is not installed on this Device');
    expect(codex?.className).toContain('opacity-40 cursor-not-allowed');

    expect(cursor?.disabled).toBe(true);
    expect(cursor?.title).toContain('Cursor Agent CLI is not installed on this Device');

    expect(opencode?.disabled).toBe(true);
    expect(opencode?.title).toContain('OpenCode CLI is not installed on this Device');

    expect(grok?.disabled).toBe(true);
    expect(grok?.title).toContain('Grok Build CLI is not installed on this Device');

    expect(terminal?.disabled).toBe(false);

    // Clicking disabled button does not trigger create/plan
    deviceSessionMocks.planCreate.mockClear();
    codex!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();
    expect(deviceSessionMocks.planCreate).not.toHaveBeenCalled();
    expect(sessionMocks.createAgentWithDefaults).not.toHaveBeenCalled();
  });

  it('disables quick launch presets whose agent CLI is not installed on the selected device', () => {
    (settings.current as { quickLaunch: Array<{ id: string; label: string; provider: import('@shared/types/sessions.js').AgentRuntimeProvider }> }).quickLaunch = [
      { id: 'preset-claude', label: 'My Claude', provider: 'claude_code' },
      { id: 'preset-codex', label: 'My Codex', provider: 'codex' }
    ];
    deviceSessionState.modelCatalogs = {
      'remote-device': [{ provider: 'claude', id: 'sonnet', label: 'Claude 3.7 Sonnet' }]
    };

    const target = mountComponent(AgentLaunchPopover, { defaultDeviceId: 'remote-device' });
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const claudePreset = document.body.querySelector<HTMLButtonElement>('[data-launch-option="preset:preset-claude"]');
    const codexPreset = document.body.querySelector<HTMLButtonElement>('[data-launch-option="preset:preset-codex"]');

    expect(claudePreset).not.toBeNull();
    expect(claudePreset?.disabled).toBe(false);
    expect(claudePreset?.title).toBe('My Claude');

    expect(codexPreset).not.toBeNull();
    expect(codexPreset?.disabled).toBe(true);
    expect(codexPreset?.getAttribute('aria-disabled')).toBe('true');
    expect(codexPreset?.title).toContain('Codex CLI is not installed on this Device');

    deviceSessionMocks.planCreate.mockClear();
    codexPreset!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();
    expect(deviceSessionMocks.planCreate).not.toHaveBeenCalled();
    expect(sessionMocks.createAgentWithDefaults).not.toHaveBeenCalled();
  });

  it('disables agent buttons in general context when device placement is not active', () => {
    deviceSessionState.multiDeviceActive = false;
    deviceSessionState.modelCatalogs = {
      'local-device': [{ provider: 'opencode', id: 'default', label: 'OpenCode default' }]
    };

    const target = mountComponent(AgentLaunchPopover, {});
    target.querySelector<HTMLButtonElement>('[aria-label="New session"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSync();

    const opencode = document.body.querySelector<HTMLButtonElement>('[data-launch-option="opencode"]');
    const claude = document.body.querySelector<HTMLButtonElement>('[data-launch-option="claude_code"]');

    expect(opencode?.disabled).toBe(false);
    expect(claude?.disabled).toBe(true);
    expect(claude?.title).toContain('Claude CLI is not installed on this Device');
  });
});
