<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    Check,
    ChevronDown,
    ChevronLeft,
    Folder,
    FolderGit2,
    FolderOpen,
    FolderPlus,
    LoaderCircle,
    Monitor,
    Plus,
    Rocket
  } from '@lucide/svelte';
  import type { DeviceId } from '@shared/types/devices.js';
  import type {
    MultiDeviceSessionCreationPlan,
    ProjectView
  } from '@shared/types/multi-device-sessions.js';
  import type { SessionLaunch } from '@shared/types/sessions.js';
  import type { WorkspaceDirectoryListing } from '@shared/types/workspaces.js';
  import type { Project, ProjectId } from '@shared/types/projects.js';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { QuickLaunchPreset } from '@shared/types/settings.js';
  import { sessions } from '../stores/sessions.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { worktreeCreateModal } from '../stores/worktree-create-modal.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { quickLaunchExtraArgs } from '../lib/quick-launch';
  import {
    agentCliUnavailableReason,
    isAgentCliAvailable
  } from '@shared/agent-cli-availability.js';
  import {
    horizontalDropPosition,
    orderProviders,
    prefersFinePointer,
    readProviderRailOrder,
    reorderIds,
    verticalDropPosition,
    writeProviderRailOrder,
    type DropPosition
  } from '../lib/provider-rail-order';
  import { Button } from '$lib/components/ui/button';
  import * as Popover from '$lib/components/ui/popover';
  import * as Select from '$lib/components/ui/select';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Input } from '$lib/components/ui/input';
  import KindIcon from './KindIcon.svelte';

  const HOVER_OPEN_DELAY_MS = 250;
  const HOVER_CLOSE_DELAY_MS = 180;
  const TOUCH_HOLD_OPEN_DELAY_MS = 350;
  const PROVIDER_DND_MIME = 'application/x-soloe-provider';
  const PRESET_DND_MIME = 'application/x-soloe-quick-launch';

  type LaunchOption = AgentRuntimeProvider | 'terminal' | `preset:${string}`;
  type PickerLevel = 'global' | 'project' | 'worktree';

  const agentProviders = [
    { value: 'opencode', label: 'OpenCode' },
    { value: 'grok_build', label: 'Grok Build' },
    { value: 'antigravity', label: 'Antigravity' },
    { value: 'claude_code', label: 'Claude' },
    { value: 'cursor', label: 'Cursor' },
    { value: 'codex', label: 'Codex' }
  ] as const satisfies ReadonlyArray<{
    value: AgentRuntimeProvider;
    label: string;
  }>;

  let {
    projectId = null,
    cwd = undefined,
    branch,
    workspaceKey,
    projectKey,
    level,
    defaultDeviceId = null,
    onSessionCreated,
    title = 'New session',
    ariaLabel = 'New session',
    class: className = '',
    side = 'right',
    align = 'start'
  }: {
    projectId?: ProjectId | null;
    cwd?: string;
    branch?: string;
    workspaceKey?: string;
    projectKey?: string;
    level?: PickerLevel;
    defaultDeviceId?: DeviceId | null;
    onSessionCreated?: (rowId: string) => void;
    title?: string;
    ariaLabel?: string;
    class?: string;
    side?: 'top' | 'right' | 'bottom' | 'left';
    align?: 'start' | 'center' | 'end';
  } = $props();

  let open = $state(false);
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let touchHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressClickTimer: ReturnType<typeof setTimeout> | null = null;
  let touchPointerId: number | null = null;
  let touchGestureOpen = false;
  let suppressNextClick = false;
  let selectedLaunchOption = $state<LaunchOption | null>(null);
  let pickerEl: HTMLElement | null = null;
  let railEl: HTMLElement | null = null;
  let railCanScroll = $state(false);
  let railAtBottom = $state(false);

  function updateRailScroll(): void {
    if (!railEl) return;
    const { scrollTop, scrollHeight, clientHeight } = railEl;
    railCanScroll = scrollHeight > clientHeight + 1;
    railAtBottom = scrollTop + clientHeight >= scrollHeight - 1;
  }

  function updateRailOnMount(node: HTMLElement): void {
    railEl = node;
    requestAnimationFrame(updateRailScroll);
  }

  let selectedDeviceId = $state<DeviceId | null>(null);
  let selectedWorkspaceKey = $state<string | null>(null);
  let placementInitialized = false;
  let devicePlan = $state<MultiDeviceSessionCreationPlan | null>(null);
  let devicePlanError = $state<string | null>(null);
  let planningDevice = $state(false);
  let launchingDevice = $state(false);
  let pendingDeviceOption = $state<LaunchOption | null>(null);
  let directoryListing = $state<WorkspaceDirectoryListing | null>(null);
  let browsingDirectories = $state(false);
  let folderName = $state('');
  let showLocationBrowser = $state(false);
  let worktreeSelectOpen = $state(false);
  let deviceSelectOpen = $state(false);
  let planRequest = 0;
  let deviceRefreshOpen = false;
  let providerOrder = $state<AgentRuntimeProvider[] | null>(readProviderRailOrder());
  let finePointer = $state(prefersFinePointer());
  let draggingProvider = $state<AgentRuntimeProvider | null>(null);
  let providerDrop = $state<{ id: AgentRuntimeProvider; position: DropPosition } | null>(null);
  let draggingPresetId = $state<string | null>(null);
  let presetDrop = $state<{ id: string; position: DropPosition } | null>(null);
  let suppressLaunchAfterDrag = false;
  let finePointerMq: MediaQueryList | null = null;

  let usesDevicePlacement = $derived(deviceSessions.multiDeviceActive);
  let pickerLevel = $derived<PickerLevel>(
    level ?? (workspaceKey !== undefined ? 'worktree' : projectId ? 'project' : 'global')
  );
  let contextualProject = $derived.by<ProjectView | null>(() => {
    if (projectKey) {
      const byKey = deviceSessions.state.projects.find((project) => project.key === projectKey);
      if (byKey) return byKey;
    }
    if (!projectId) return null;
    return deviceSessions.state.projects.find((project) =>
      (project.presences ?? []).some((presence) => presence.ref.projectId === projectId)
      || project.workspaces.some((workspace) =>
        workspace.locations.some((location) => location.projectId === projectId)
      )
    ) ?? null;
  });
  let effectiveWorkspaceKey = $derived(
    pickerLevel === 'worktree' ? workspaceKey ?? selectedWorkspaceKey : selectedWorkspaceKey
  );
  let workspaceChoices = $derived.by(() => deviceSessions.state.projects
    .filter((project) => pickerLevel !== 'project' || project.key === contextualProject?.key)
    .flatMap((project) => project.workspaces.map((workspace) => ({
      key: workspace.key,
      label: workspace.branch ?? workspace.name,
      branch: workspace.branch,
      projectKey: project.key,
      projectName: project.name,
      locations: workspace.locations,
      deviceSummary: Array.from(new Set(workspace.locations.map((location) => location.deviceName)))
        .join(', ')
    })))
  );
  let selectedWorkspace = $derived(
    effectiveWorkspaceKey
      ? workspaceChoices.find((workspace) => workspace.key === effectiveWorkspaceKey) ?? null
      : null
  );
  let selectedDevice = $derived(
    selectedDeviceId ? deviceSessions.device(selectedDeviceId) : null
  );
  let worktreeProject = $derived.by<ProjectView | null>(() => {
    if (pickerLevel === 'project') return contextualProject;
    if (!selectedWorkspace) return null;
    return deviceSessions.state.projects.find((project) =>
      project.key === selectedWorkspace.projectKey
    ) ?? null;
  });
  let worktreeTarget = $derived.by<{
    project: Project;
    deviceId?: DeviceId;
    deviceName?: string;
  } | null>(() => {
    if (pickerLevel === 'worktree') return null;
    if (!usesDevicePlacement) {
      const project = projectId ? projects.get(projectId) : null;
      return project ? { project } : null;
    }
    const targetDevice = selectedDevice;
    const logicalProject = worktreeProject;
    if (!targetDevice || !logicalProject) return null;
    const target = targetDevice.local
      ? { deviceName: targetDevice.name }
      : { deviceId: targetDevice.deviceId, deviceName: targetDevice.name };
    const presence = (logicalProject.presences ?? []).find((candidate) =>
      candidate.ref.deviceId === targetDevice.deviceId
    );
    if (presence) return { project: presence.project, ...target };
    const location = logicalProject.workspaces
      .flatMap((workspace) => workspace.locations)
      .find((candidate) => candidate.deviceId === targetDevice.deviceId);
    if (!location) return null;
    const localProject = targetDevice.local ? projects.get(location.projectId) : null;
    if (localProject) return { project: localProject, ...target };
    const observedAt = deviceSessions.state.capturedAt;
    return {
      project: {
        id: location.projectId,
        name: logicalProject.name,
        path: location.path,
        ...(targetDevice.platform ? { defaultRunMode: targetDevice.platform } : {}),
        createdAt: observedAt,
        lastOpenedAt: observedAt
      },
      ...target
    };
  });
  let customTargetPath = $derived.by(() => {
    if (!directoryListing || !folderName.trim()) return undefined;
    return `${directoryListing.path}${directoryListing.path.endsWith(directoryListing.separator) ? '' : directoryListing.separator}${folderName.trim()}`;
  });

  $effect(() => {
    const nextOpen = open;
    if (nextOpen && !deviceRefreshOpen) {
      void deviceSessions.refresh({ background: true }).catch(reportError);
    }
    deviceRefreshOpen = nextOpen;
  });

  $effect(() => {
    // Launching already obtains the authoritative plan. Re-previewing while it
    // executes replaces the ready card with the shorter loading row and makes
    // the popover visibly jump before it closes.
    if (!open || !usesDevicePlacement || launchingDevice) return;
    if (!placementInitialized) {
      const contextualWorkspace = pickerLevel === 'global'
        ? undefined
        : workspaceKey
          ? workspaceChoices.find((workspace) => workspace.key === workspaceKey)
          : workspaceChoices.find((workspace) => workspace.locations.some((location) =>
              (projectId ? location.projectId === projectId : true)
              && (cwd ? location.path === cwd : true)
            ));
      selectedWorkspaceKey = contextualWorkspace?.key
        ?? (pickerLevel === 'project' ? workspaceChoices[0]?.key : null)
        ?? null;
      placementInitialized = true;
    }
    const availableIds = new Set(deviceSessions.visibleDevices.map((device) => device.deviceId));
    const preferred = defaultDeviceId && availableIds.has(defaultDeviceId)
      ? defaultDeviceId
      : deviceSessions.localDevice?.deviceId ?? deviceSessions.visibleDevices[0]?.deviceId ?? null;
    if (!selectedDeviceId || !availableIds.has(selectedDeviceId)) {
      selectedDeviceId = preferred;
      return;
    }
    const deviceId = selectedDeviceId;
    const targetPath = customTargetPath;
    void previewDevicePlan(deviceId, targetPath);
  });

  let effectiveTargetDeviceId = $derived<DeviceId | null>(
    (usesDevicePlacement ? selectedDeviceId : null)
      ?? defaultDeviceId
      ?? deviceSessions.selectedDeviceId
      ?? deviceSessions.activeDeviceId
      ?? deviceSessions.localDevice?.deviceId
      ?? null
  );

  $effect(() => {
    if (open && effectiveTargetDeviceId) {
      void deviceSessions.loadModelCatalog?.(effectiveTargetDeviceId)?.catch(() => undefined);
    }
  });

  let currentDeviceCatalog = $derived(
    effectiveTargetDeviceId ? deviceSessions.modelCatalogForDevice?.(effectiveTargetDeviceId) ?? null : null
  );

  function isProviderAvailable(provider: AgentRuntimeProvider): boolean {
    if (!currentDeviceCatalog) return true;
    return isAgentCliAvailable(currentDeviceCatalog, provider);
  }

  function providerDisabledReason(provider: AgentRuntimeProvider): string | null {
    if (currentDeviceCatalog && !isAgentCliAvailable(currentDeviceCatalog, provider)) {
      return agentCliUnavailableReason(provider);
    }
    return null;
  }

  function isOptionDisabled(option: LaunchOption): boolean {
    if (option === 'terminal') return false;
    if (
      option === 'claude_code'
      || option === 'codex'
      || option === 'cursor'
      || option === 'opencode'
      || option === 'grok_build'
      || option === 'antigravity'
    ) {
      return !isProviderAvailable(option);
    }
    if (option.startsWith('preset:')) {
      const presetId = option.slice('preset:'.length);
      const preset = presets.find((candidate) => candidate.id === presetId);
      return preset ? !isProviderAvailable(preset.provider) : false;
    }
    return false;
  }

  function clearOpenTimer(): void {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  }

  function clearCloseTimer(): void {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function clearTimers(): void {
    clearOpenTimer();
    clearCloseTimer();
  }

  function clearTouchHoldTimer(): void {
    if (!touchHoldTimer) return;
    clearTimeout(touchHoldTimer);
    touchHoldTimer = null;
  }

  function clearSuppressClickTimer(): void {
    if (!suppressClickTimer) return;
    clearTimeout(suppressClickTimer);
    suppressClickTimer = null;
  }

  function scheduleOpen(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    clearCloseTimer();
    if (open || openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      open = true;
    }, HOVER_OPEN_DELAY_MS);
  }

  function scheduleClose(event: PointerEvent): void {
    if (event.pointerType === 'touch' || touchPointerId !== null) return;
    if (worktreeSelectOpen || deviceSelectOpen) {
      clearCloseTimer();
      return;
    }
    if (openTimer) {
      clearOpenTimer();
      return;
    }
    if (!open || closeTimer) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      open = false;
    }, HOVER_CLOSE_DELAY_MS);
  }

  function onTriggerClick(e: Event): void {
    e.stopPropagation();
    if (suppressNextClick) {
      e.preventDefault();
      suppressNextClick = false;
      clearSuppressClickTimer();
      return;
    }
    clearTimers();
    open = true;
  }

  function onTriggerDragStart(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function onTriggerContextMenu(event: MouseEvent): void {
    if (touchPointerId !== null || touchGestureOpen) event.preventDefault();
  }

  function onTouchPointerDown(event: PointerEvent): void {
    event.stopPropagation();
    if (event.pointerType !== 'touch' || !event.isPrimary || event.button !== 0) return;
    clearTimers();
    clearTouchHoldTimer();
    clearSuppressClickTimer();
    selectedLaunchOption = null;
    touchPointerId = event.pointerId;
    touchGestureOpen = false;
    suppressNextClick = false;
    try {
      event.currentTarget instanceof Element
        && event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture may be unavailable in embedded or synthetic browser environments.
    }
    touchHoldTimer = setTimeout(() => {
      touchHoldTimer = null;
      if (touchPointerId !== event.pointerId) return;
      touchGestureOpen = true;
      suppressNextClick = true;
      open = true;
    }, TOUCH_HOLD_OPEN_DELAY_MS);
  }

  function launchOptionAtPoint(clientX: number, clientY: number): LaunchOption | null {
    if (!pickerEl || typeof document.elementFromPoint !== 'function') return null;
    const hit = document.elementFromPoint(clientX, clientY);
    const option = hit instanceof Element
      ? hit.closest<HTMLElement>('[data-launch-option]')
      : null;
    if (!option || !pickerEl.contains(option)) return null;
    return (option.dataset.launchOption as LaunchOption | undefined) ?? null;
  }

  function onTouchPointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || event.pointerId !== touchPointerId) return;
    if (!touchGestureOpen) return;
    event.preventDefault();
    const candidate = launchOptionAtPoint(event.clientX, event.clientY);
    selectedLaunchOption = candidate && !isOptionDisabled(candidate) ? candidate : null;
  }

  function releasePointer(event: PointerEvent): void {
    try {
      event.currentTarget instanceof Element
        && event.currentTarget.hasPointerCapture(event.pointerId)
        && event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may already have released capture while closing the popover.
    }
  }

  function finishTouchGesture(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || event.pointerId !== touchPointerId) return;
    clearTouchHoldTimer();
    releasePointer(event);
    touchPointerId = null;
    if (!touchGestureOpen) return;

    event.preventDefault();
    event.stopPropagation();
    const candidate = launchOptionAtPoint(event.clientX, event.clientY) ?? selectedLaunchOption;
    const option = candidate && !isOptionDisabled(candidate) ? candidate : null;
    touchGestureOpen = false;
    selectedLaunchOption = null;
    suppressNextClick = true;
    clearSuppressClickTimer();
    suppressClickTimer = setTimeout(() => {
      suppressClickTimer = null;
      suppressNextClick = false;
    }, 0);
    if (option) launchOption(option);
  }

  function cancelTouchGesture(event: PointerEvent): void {
    if (event.pointerId !== touchPointerId) return;
    clearTouchHoldTimer();
    releasePointer(event);
    touchPointerId = null;
    touchGestureOpen = false;
    selectedLaunchOption = null;
  }

  function onOpenChange(next: boolean): void {
    if (!next) clearTimers();
    if (!next) {
      placementInitialized = false;
      pendingDeviceOption = null;
      showLocationBrowser = false;
      directoryListing = null;
      worktreeSelectOpen = false;
      deviceSelectOpen = false;
    }
  }

  function selectWorkspace(key: string | null): void {
    selectedWorkspaceKey = key;
    pendingDeviceOption = null;
    directoryListing = null;
    showLocationBrowser = false;
    folderName = '';
  }

  function openProjectOnSelectedDevice(): void {
    const deviceId = selectedDeviceId
      ?? deviceSessions.localDevice?.deviceId
      ?? null;
    open = false;
    commandPalette.openProject(deviceId);
  }

  function openWorktreeCreator(): void {
    const target = worktreeTarget;
    if (!target) return;
    open = false;
    worktreeCreateModal.openFor(
      target.project,
      selectedWorkspace?.branch ?? branch,
      {
        ...(target.deviceId ? { deviceId: target.deviceId } : {}),
        ...(target.deviceName ? { deviceName: target.deviceName } : {})
      }
    );
  }

  function launchForOption(option: LaunchOption): SessionLaunch {
    if (option === 'terminal') {
      return { type: 'terminal', shell: settings.current.defaults.shell };
    }
    if (
      option === 'claude_code'
      || option === 'codex'
      || option === 'cursor'
      || option === 'opencode'
      || option === 'grok_build'
      || option === 'antigravity'
    ) {
      return {
        type: 'agent',
        provider: option,
        resumeMode: 'new',
        ...(option === 'claude_code' ? { fullscreenTui: true } : {}),
        ...(option === 'cursor' ? { cursorMode: 'agent' as const } : {})
      };
    }
    const preset = presets.find((candidate) => candidate.id === option.slice('preset:'.length));
    if (!preset) return { type: 'terminal', shell: settings.current.defaults.shell };
    const extraArgs = quickLaunchExtraArgs(preset);
    return {
      type: 'agent',
      provider: preset.provider,
      resumeMode: 'new',
      ...(preset.provider === 'claude_code' ? { fullscreenTui: true } : {}),
      ...(preset.model ? { model: preset.model } : {}),
      ...(extraArgs.length ? { extraArgs } : {})
    };
  }

  function sessionName(option: LaunchOption): string {
    if (option === 'terminal') return branch ? `${branch} terminal` : 'Terminal';
    if (option === 'claude_code') return branch ? `${branch} Claude` : 'Claude';
    if (option === 'codex') return branch ? `${branch} Codex` : 'Codex';
    if (option === 'cursor') return branch ? `${branch} Cursor` : 'Cursor';
    if (option === 'opencode') return branch ? `${branch} OpenCode` : 'OpenCode';
    if (option === 'grok_build') return branch ? `${branch} Grok Build` : 'Grok Build';
    if (option === 'antigravity') return branch ? `${branch} Antigravity` : 'Antigravity';
    return presets.find((candidate) => candidate.id === option.slice('preset:'.length))?.label
      ?? 'Session';
  }

  function preferredOption(): LaunchOption {
    return settings.current.defaults.newSessionKind;
  }

  function deviceRequest(
    option: LaunchOption,
    deviceId: DeviceId,
    targetPath?: string
  ) {
    return {
      workspaceKey: effectiveWorkspaceKey,
      targetDeviceId: deviceId,
      ...(targetPath ? { targetPath } : {}),
      session: {
        name: sessionName(option),
        launch: launchForOption(option)
      }
    };
  }

  async function previewDevicePlan(deviceId: DeviceId, targetPath?: string): Promise<void> {
    const requestId = ++planRequest;
    planningDevice = true;
    devicePlanError = null;
    try {
      const plan = await deviceSessions.planCreate(deviceRequest(
        pendingDeviceOption ?? preferredOption(),
        deviceId,
        targetPath
      ));
      if (requestId !== planRequest) return;
      devicePlan = plan;
    } catch (error) {
      if (requestId !== planRequest) return;
      devicePlanError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === planRequest) planningDevice = false;
    }
  }

  async function launchOnDevice(option: LaunchOption): Promise<void> {
    if (isOptionDisabled(option)) return;
    const availableIds = new Set(deviceSessions.visibleDevices
      .filter((device) => device.available)
      .map((device) => device.deviceId));
    const targetDeviceId = selectedDeviceId && availableIds.has(selectedDeviceId)
      ? selectedDeviceId
      : defaultDeviceId && availableIds.has(defaultDeviceId)
        ? defaultDeviceId
        : deviceSessions.localDevice?.deviceId ?? deviceSessions.visibleDevices[0]?.deviceId ?? null;
    if (!targetDeviceId || launchingDevice) return;
    selectedDeviceId = targetDeviceId;
    launchingDevice = true;
    devicePlanError = null;
    const notifyCreated = onSessionCreated;
    try {
      const plan = await deviceSessions.planCreate(deviceRequest(
        option,
        targetDeviceId,
        customTargetPath
      ));
      devicePlan = plan;
      pendingDeviceOption = option;
      if (plan.action !== 'use-existing-location' && plan.action !== 'use-device-directory') return;
      const created = await deviceSessions.executeCreate(plan.planId);
      notifyCreated?.(created.key);
      open = false;
    } catch (error) {
      devicePlanError = error instanceof Error ? error.message : String(error);
    } finally {
      launchingDevice = false;
    }
  }

  async function prepareAndLaunch(): Promise<void> {
    if (!devicePlan || !pendingDeviceOption || launchingDevice) return;
    launchingDevice = true;
    const notifyCreated = onSessionCreated;
    try {
      const created = await deviceSessions.executeCreate(devicePlan.planId);
      notifyCreated?.(created.key);
      open = false;
    } catch (error) {
      devicePlanError = error instanceof Error ? error.message : String(error);
    } finally {
      launchingDevice = false;
    }
  }

  async function browse(path?: string): Promise<void> {
    if (!selectedDeviceId) return;
    if (!folderName) folderName = pathName(cwd ?? branch ?? 'workspace');
    browsingDirectories = true;
    devicePlanError = null;
    try {
      directoryListing = await deviceSessions.browseWorkspaceDirectories(selectedDeviceId, path);
      showLocationBrowser = true;
    } catch (error) {
      devicePlanError = error instanceof Error ? error.message : String(error);
    } finally {
      browsingDirectories = false;
    }
  }

  function pathName(value: string): string {
    return value.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'workspace';
  }

  function launchTerminal(): void {
    if (usesDevicePlacement) {
      void launchOnDevice('terminal');
      return;
    }
    open = false;
    const notifyCreated = onSessionCreated;
    void sessions
      .createWithDefaults({
        ...(projectId ? { projectId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {})
      })
      .then((created) => notifyCreated?.(created.id))
      .catch(reportError);
  }

  function launchAgent(kind: AgentRuntimeProvider): void {
    if (usesDevicePlacement) {
      void launchOnDevice(kind);
      return;
    }
    open = false;
    const notifyCreated = onSessionCreated;
    void sessions
      .createAgentWithDefaults(kind, {
        ...(projectId ? { projectId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {})
      })
      .then((created) => notifyCreated?.(created.id))
      .catch(reportError);
  }

  function launchPreset(preset: QuickLaunchPreset): void {
    if (usesDevicePlacement) {
      void launchOnDevice(`preset:${preset.id}`);
      return;
    }
    open = false;
    const args = quickLaunchExtraArgs(preset);
    const notifyCreated = onSessionCreated;
    void sessions
      .createAgentWithDefaults(preset.provider, {
        ...(projectId ? { projectId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {}),
        ...(preset.model ? { model: preset.model } : {}),
        ...(args.length ? { extraArgs: args } : {})
      })
      .then((created) => notifyCreated?.(created.id))
      .catch(reportError);
  }

  function launchOption(option: LaunchOption): void {
    if (isOptionDisabled(option)) return;
    if (option === 'terminal') {
      launchTerminal();
      return;
    }
    if (
      option === 'claude_code'
      || option === 'codex'
      || option === 'cursor'
      || option === 'opencode'
      || option === 'grok_build'
      || option === 'antigravity'
    ) {
      launchAgent(option);
      return;
    }
    const presetId = option.slice('preset:'.length);
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (preset) launchPreset(preset);
  }

  let presets = $derived(settings.current.quickLaunch);
  let orderedProviders = $derived(orderProviders(agentProviders, providerOrder));

  function onFinePointerChange(): void {
    finePointer = prefersFinePointer();
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    finePointerMq = window.matchMedia('(pointer: fine)');
    finePointerMq.addEventListener('change', onFinePointerChange);
  }

  function endProviderDrag(): void {
    draggingProvider = null;
    providerDrop = null;
  }

  function endPresetDrag(): void {
    draggingPresetId = null;
    presetDrop = null;
  }

  function onProviderDragStart(event: DragEvent, provider: AgentRuntimeProvider): void {
    if (!finePointer || touchPointerId !== null || touchGestureOpen || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROVIDER_DND_MIME, provider);
    draggingProvider = provider;
    providerDrop = null;
    suppressLaunchAfterDrag = false;
  }

  function onProviderDragOver(event: DragEvent, provider: AgentRuntimeProvider, el: HTMLElement): void {
    if (!draggingProvider || draggingProvider === provider) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const position = verticalDropPosition(event, el);
    if (
      providerDrop?.id !== provider
      || providerDrop.position !== position
    ) {
      providerDrop = { id: provider, position };
    }
  }

  function onProviderDrop(event: DragEvent, provider: AgentRuntimeProvider): void {
    if (!draggingProvider || draggingProvider === provider) return;
    event.preventDefault();
    const position = providerDrop?.id === provider
      ? providerDrop.position
      : 'after';
    const next = reorderIds(
      orderedProviders.map((item) => item.value),
      draggingProvider,
      provider,
      position
    );
    if (next) {
      providerOrder = next;
      writeProviderRailOrder(providerOrder);
      suppressLaunchAfterDrag = true;
    }
    endProviderDrag();
  }

  function onProviderDragEnd(): void {
    endProviderDrag();
  }

  function onPresetDragStart(event: DragEvent, presetId: string): void {
    if (!finePointer || touchPointerId !== null || touchGestureOpen || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PRESET_DND_MIME, presetId);
    draggingPresetId = presetId;
    presetDrop = null;
    suppressLaunchAfterDrag = false;
  }

  function onPresetDragOver(event: DragEvent, presetId: string, el: HTMLElement): void {
    if (!draggingPresetId || draggingPresetId === presetId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const position = horizontalDropPosition(event, el);
    if (presetDrop?.id !== presetId || presetDrop.position !== position) {
      presetDrop = { id: presetId, position };
    }
  }

  function onPresetDrop(event: DragEvent, presetId: string): void {
    if (!draggingPresetId || draggingPresetId === presetId) return;
    event.preventDefault();
    const position = presetDrop?.id === presetId ? presetDrop.position : 'after';
    const ids = presets.map((preset) => preset.id);
    const nextIds = reorderIds(ids, draggingPresetId, presetId, position);
    if (nextIds) {
      const byId = new Map(presets.map((preset) => [preset.id, preset]));
      const next = nextIds.flatMap((id) => {
        const preset = byId.get(id);
        return preset ? [preset] : [];
      });
      suppressLaunchAfterDrag = true;
      void settings.update({ quickLaunch: next }).catch(reportError);
    }
    endPresetDrag();
  }

  function onPresetDragEnd(): void {
    endPresetDrag();
  }

  function onLaunchOptionClick(event: MouseEvent, option: LaunchOption): void {
    event.stopPropagation();
    if (isOptionDisabled(option)) {
      event.preventDefault();
      return;
    }
    if (suppressLaunchAfterDrag) {
      suppressLaunchAfterDrag = false;
      event.preventDefault();
      return;
    }
    if (suppressNextClick) {
      event.preventDefault();
      suppressNextClick = false;
      clearSuppressClickTimer();
      return;
    }
    launchOption(option);
  }

  onDestroy(() => {
    clearTimers();
    clearTouchHoldTimer();
    clearSuppressClickTimer();
    finePointerMq?.removeEventListener('change', onFinePointerChange);
  });
</script>

<Popover.Root bind:open {onOpenChange}>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class={`shrink-0 touch-none ${className}`}
        {title}
        aria-label={ariaLabel}
        draggable="false"
        onclick={onTriggerClick}
        oncontextmenu={onTriggerContextMenu}
        ondragstart={onTriggerDragStart}
        onpointerdown={onTouchPointerDown}
        onpointerenter={scheduleOpen}
        onpointerleave={scheduleClose}
        onpointermove={onTouchPointerMove}
        onpointerup={finishTouchGesture}
        onpointercancel={cancelTouchGesture}
      >
        <Plus />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    {align}
    {side}
    sideOffset={8}
    class="z-40 w-[min(27rem,calc(100vw-1rem))] overflow-hidden rounded-md border-border bg-card p-0 shadow-md"
    onpointerenter={clearCloseTimer}
    onpointerleave={scheduleClose}
  >
    <div bind:this={pickerEl} class="grid min-h-0 grid-cols-[3rem_minmax(0,1fr)] items-start">
      <div
        data-slot="provider-rail-column"
        class="relative flex max-h-[13.5rem] min-h-0 flex-col overflow-hidden border-r border-border bg-foreground/[0.035]"
      >
        <div
          data-slot="provider-rail"
          class="no-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pt-2 pb-1"
          aria-label="Agents"
          onscroll={updateRailScroll}
          use:updateRailOnMount
        >
          {#each orderedProviders as provider (provider.value)}
            {@const unavailableReason = providerDisabledReason(provider.value)}
            {@const isAvailable = !unavailableReason}
            <button
              type="button"
              class={`relative mx-auto flex size-9 shrink-0 items-center justify-center rounded-md border border-transparent outline-none transition-colors hover:bg-background/80 hover:border-border/70 active:bg-muted active:border-border focus-visible:ring-2 focus-visible:ring-ring/50 ${selectedLaunchOption === provider.value ? 'bg-background border-border shadow-sm' : ''} ${draggingProvider === provider.value ? 'opacity-40' : ''} ${!isAvailable ? 'opacity-40 cursor-not-allowed hover:bg-transparent hover:border-transparent' : ''}`}
              title={unavailableReason ?? provider.label}
              aria-label={unavailableReason ? `${provider.label} (${unavailableReason})` : `New ${provider.label} session`}
              data-launch-option={provider.value}
              data-gesture-selected={selectedLaunchOption === provider.value ? 'true' : undefined}
              aria-disabled={!isAvailable ? 'true' : undefined}
              disabled={!isAvailable}
              draggable={finePointer}
              onclick={(event) => onLaunchOptionClick(event, provider.value)}
              ondragstart={(event) => onProviderDragStart(event, provider.value)}
              ondragover={(event) => onProviderDragOver(event, provider.value, event.currentTarget)}
              ondrop={(event) => onProviderDrop(event, provider.value)}
              ondragend={onProviderDragEnd}
            >
              {#if providerDrop?.id === provider.value && providerDrop.position === 'before'}
                <span
                  class="pointer-events-none absolute inset-x-1 top-0 z-10 h-0.5 rounded-full bg-primary"
                  aria-hidden="true"
                ></span>
              {/if}
              {#if providerDrop?.id === provider.value && providerDrop.position === 'after'}
                <span
                  class="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-0.5 rounded-full bg-primary"
                  aria-hidden="true"
                ></span>
              {/if}
              <KindIcon kind={provider.value} size={17} />
            </button>
          {/each}
        </div>
        {#if railCanScroll && !railAtBottom}
          <div
            class="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-card via-card/85 to-transparent"
            aria-hidden="true"
          ></div>
        {/if}
        <div
          data-slot="provider-rail-separator"
          class="mx-2 shrink-0 border-t border-border"
          aria-hidden="true"
        ></div>
        <div class="flex shrink-0 justify-center px-1.5 pt-1.5 pb-2">
          <button
            type="button"
            class={`relative flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent outline-none transition-colors hover:bg-background/80 hover:border-border/70 active:bg-muted active:border-border focus-visible:ring-2 focus-visible:ring-ring/50 ${selectedLaunchOption === 'terminal' ? 'bg-background border-border shadow-sm' : ''}`}
            title="Terminal"
            aria-label="New terminal"
            data-launch-option="terminal"
            data-gesture-selected={selectedLaunchOption === 'terminal' ? 'true' : undefined}
            onclick={(event) => onLaunchOptionClick(event, 'terminal')}
          >
            <KindIcon kind="terminal" size={15} />
          </button>
        </div>
      </div>

      <div class="min-w-0">
        {#if usesDevicePlacement}
          <div class="no-scrollbar flex max-h-[18rem] flex-col gap-1.5 overflow-y-auto p-2">
          {#if pickerLevel !== 'worktree'}
            <span class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Worktree</span>
            <DropdownMenu.Root bind:open={worktreeSelectOpen}>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="outline"
                    class="h-8 w-full min-w-0 justify-start gap-2 px-2 text-xs font-normal"
                    aria-label="Choose worktree"
                  >
                    <FolderGit2 class="size-3.5 shrink-0" />
                    <span class="min-w-0 flex-1 truncate text-left">
                      {selectedWorkspace
                        ? `${selectedWorkspace.projectName} · ${selectedWorkspace.label}`
                        : pickerLevel === 'global' ? 'No project' : 'Choose worktree'}
                    </span>
                    {#if selectedWorkspace?.deviceSummary}
                      <span
                        data-slot="device-chip"
                        class="inline-flex max-w-24 shrink-0 items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                      >
                        <Monitor class="size-2.5 shrink-0" />
                        <span class="truncate">
                          {selectedWorkspace.deviceSummary}
                        </span>
                      </span>
                    {/if}
                    <ChevronDown class="size-3 shrink-0 opacity-60" />
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content
                align="start"
                class="bg-card text-card-foreground"
                onpointerenter={clearCloseTimer}
                onpointerleave={scheduleClose}
              >
                <DropdownMenu.Label>Worktree</DropdownMenu.Label>
                {#if pickerLevel === 'global'}
                  <DropdownMenu.Item onSelect={openProjectOnSelectedDevice}>
                    <FolderOpen />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate">Open a project on {selectedDevice?.name ?? 'selected device'}</span>
                      <span class="truncate text-[10px] text-muted-foreground">Browse folders on this Device</span>
                    </span>
                  </DropdownMenu.Item>
                {/if}
                <DropdownMenu.Item disabled={!worktreeTarget} onSelect={openWorktreeCreator}>
                  <FolderPlus />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="flex min-w-0 items-center gap-1.5">
                      <span class="truncate">Add worktree</span>
                      {#if selectedDevice}
                        <span
                          data-slot="device-chip"
                          class="inline-flex max-w-32 shrink-0 items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                        >
                          <Monitor class="size-2.5 shrink-0" />
                          <span class="truncate">{selectedDevice.name}</span>
                        </span>
                      {/if}
                    </span>
                    {#if !worktreeTarget}
                      <span class="truncate text-[10px] text-muted-foreground">Choose a project available on this Device</span>
                    {/if}
                  </span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                {#if pickerLevel === 'global'}
                  <DropdownMenu.Item
                    class={!selectedWorkspace ? 'bg-accent text-accent-foreground' : ''}
                    onSelect={() => selectWorkspace(null)}
                  >
                    <Folder />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span>No project</span>
                      <span class="text-[10px] text-muted-foreground">Open in the Device home folder</span>
                    </span>
                    {#if !selectedWorkspace}<Check class="ml-auto size-3" />{/if}
                  </DropdownMenu.Item>
                {/if}
                {#each workspaceChoices as workspace (workspace.key)}
                  <DropdownMenu.Item
                    class={workspace.key === effectiveWorkspaceKey ? 'bg-accent text-accent-foreground' : ''}
                    onSelect={() => selectWorkspace(workspace.key)}
                  >
                    <FolderGit2 />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate">{workspace.label}</span>
                      <span class="truncate text-[10px] text-muted-foreground">
                        {workspace.projectName}
                      </span>
                    </span>
                    {#if workspace.deviceSummary}
                      <span
                        data-slot="device-chip"
                        class="ml-auto inline-flex max-w-28 shrink-0 items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                      >
                        <Monitor class="size-2.5 shrink-0" />
                        <span class="truncate">{workspace.deviceSummary}</span>
                      </span>
                    {/if}
                    {#if workspace.key === effectiveWorkspaceKey}<Check class="size-3 shrink-0" />{/if}
                  </DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          {/if}
          <span class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Run on device</span>
          <Select.Root
            type="single"
            bind:open={deviceSelectOpen}
            value={selectedDeviceId ?? undefined}
            onValueChange={(value) => {
              selectedDeviceId = value as DeviceId;
              pendingDeviceOption = null;
              directoryListing = null;
              showLocationBrowser = false;
              folderName = '';
            }}
          >
            <Select.Trigger class="h-8 w-full text-xs" aria-label="Choose device">
              <span class="flex min-w-0 items-center gap-2">
                <Monitor class="size-3.5 shrink-0" />
                <span class="truncate">{selectedDevice?.name ?? 'Choose device'}</span>
                {#if selectedDevice}
                  {#if selectedDevice.local}
                    <span class="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                      this device
                    </span>
                  {/if}
                  <span class={`ml-auto size-2 shrink-0 rounded-full ${selectedDevice.available ? 'bg-success' : 'bg-muted-foreground/50'}`}></span>
                {/if}
              </span>
            </Select.Trigger>
            <Select.Content
              class="w-(--bits-select-anchor-width) bg-card text-card-foreground"
              onpointerenter={clearCloseTimer}
              onpointerleave={scheduleClose}
            >
              {#each deviceSessions.visibleDevices as device (device.deviceId)}
                <Select.Item value={device.deviceId} label={device.name} disabled={!device.available}>
                  <span class="flex w-full items-center gap-2">
                    <span class={`size-2 rounded-full ${device.available ? 'bg-success' : 'bg-muted-foreground/50'}`}></span>
                    <span>{device.name}</span>
                    <span class="ml-auto text-[10px] text-muted-foreground">{device.local ? 'this device' : device.state}</span>
                  </span>
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>

          {#if effectiveWorkspaceKey && (devicePlan || planningDevice || devicePlanError)}
            <div
              data-slot="workspace-plan"
              class="relative min-h-12 rounded border border-border bg-muted/25 p-2 pr-7 text-[11px]"
            >
              {#if devicePlanError}
                <p class="m-0 text-destructive">{devicePlanError}</p>
              {:else if devicePlan}
                <p class="m-0 font-medium">
                  {devicePlan.action === 'use-existing-location'
                    ? 'Workspace ready'
                    : devicePlan.action === 'use-device-directory'
                      ? 'Device folder ready'
                    : devicePlan.action === 'clone-project'
                      ? 'Project is not initialized on this device'
                      : 'This checkout is not on this device'}
                </p>
                {#if devicePlan.targetPath}
                  <p class="mt-1 mb-0 truncate font-mono text-[10px] text-muted-foreground" title={devicePlan.targetPath}>{devicePlan.targetPath}</p>
                {/if}
                {#each devicePlan.blockers as blocker (blocker)}
                  <p class="mt-1 mb-0 text-destructive">{blocker}</p>
                {/each}
              {:else}
                <p class="m-0 flex items-center gap-1.5 text-muted-foreground">
                  <LoaderCircle class="size-3 animate-spin" /> Checking workspace…
                </p>
              {/if}
              {#if planningDevice && devicePlan}
                <LoaderCircle
                  class="absolute top-2 right-2 size-3 animate-spin text-muted-foreground"
                  aria-label="Refreshing workspace"
                />
              {/if}
            </div>
          {:else if devicePlanError}
            <p class="m-0 text-[11px] text-destructive">{devicePlanError}</p>
          {/if}

          {#if devicePlan && devicePlan.action !== 'use-existing-location' && devicePlan.action !== 'use-device-directory'}
            <Button
              variant="outline"
              size="sm"
              class="h-7 w-full justify-start gap-1.5 text-[11px]"
              disabled={browsingDirectories}
              onclick={() => showLocationBrowser ? (showLocationBrowser = false) : void browse()}
            >
              {#if browsingDirectories}<LoaderCircle class="size-3 animate-spin" />{:else}<Folder class="size-3" />{/if}
              {showLocationBrowser ? 'Hide location browser' : 'Choose workspace location'}
            </Button>
          {/if}

          {#if showLocationBrowser && directoryListing}
            <div class="flex flex-col gap-1.5 rounded border border-border p-1.5">
              <div class="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={!directoryListing.parentPath || browsingDirectories}
                  title="Parent folder"
                  aria-label="Parent folder"
                  onclick={() => void browse(directoryListing?.parentPath ?? undefined)}
                ><ChevronLeft class="size-3" /></Button>
                <span class="min-w-0 flex-1 truncate font-mono text-[10px]" title={directoryListing.path}>{directoryListing.path}</span>
              </div>
              <div class="max-h-28 overflow-y-auto rounded bg-muted/20 p-0.5">
                {#each directoryListing.directories as directory (directory.path)}
                  <button
                    type="button"
                    class="flex h-6 w-full items-center gap-1.5 rounded px-1.5 text-left text-[11px] hover:bg-muted"
                    onclick={() => void browse(directory.path)}
                  ><Folder class="size-3 shrink-0" /><span class="truncate">{directory.name}</span></button>
                {:else}
                  <p class="m-0 px-1.5 py-1 text-[10px] text-muted-foreground">No subfolders</p>
                {/each}
              </div>
              <label class="flex flex-col gap-1 text-[10px] text-muted-foreground">
                New folder
                <Input class="h-7 font-mono text-[11px]" bind:value={folderName} aria-label="New workspace folder" />
              </label>
            </div>
          {/if}
        </div>
        {:else}
          <div class="flex flex-col gap-1.5 p-2">
            {#if pickerLevel === 'project' && worktreeTarget}
              <Button
                variant="ghost"
                class="h-8 w-full justify-start gap-2 px-2 text-xs"
                onclick={openWorktreeCreator}
              >
                <FolderPlus class="size-3.5" />
                Add worktree
              </Button>
            {/if}
            <span class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Run on device</span>
            <div class="flex h-8 min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2 text-xs">
              <Monitor class="size-3.5 shrink-0" />
              <span class="min-w-0 flex-1 truncate">{deviceSessions.localDevice?.name ?? 'This device'}</span>
              <span class="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                this device
              </span>
              <span class="size-2 shrink-0 rounded-full bg-success"></span>
            </div>
            {#if cwd}
              <div class="min-w-0 rounded border border-border bg-muted/25 p-2 text-[11px]">
                <p class="m-0 font-medium">Workspace ready</p>
                <p class="mt-1 mb-0 truncate font-mono text-[10px] text-muted-foreground" title={cwd}>{cwd}</p>
              </div>
            {/if}
          </div>
        {/if}

        <div class="border-t border-border p-2">
          <div class="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <Rocket class="size-3" aria-hidden="true" />
            Quick launch
          </div>
          <div
            data-slot="quick-launch-strip"
            class="no-scrollbar flex min-w-0 flex-wrap overflow-x-auto gap-1.5"
          >
            {#each presets as preset (preset.id)}
              {@const unavailableReason = providerDisabledReason(preset.provider)}
              {@const isAvailable = !unavailableReason}
              <Button
                variant="ghost"
                class={`relative h-8 min-w-0 max-w-44 gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 text-xs transition-colors hover:bg-muted/60 hover:border-border active:bg-muted/90 active:border-primary/50 ${selectedLaunchOption === `preset:${preset.id}` ? 'border-primary/50 bg-primary/10 text-foreground' : ''} ${draggingPresetId === preset.id ? 'opacity-40' : ''} ${!isAvailable ? 'opacity-40 cursor-not-allowed hover:bg-muted/20 hover:border-border/60' : ''}`}
                title={unavailableReason ?? preset.label}
                aria-label={unavailableReason ? `${preset.label} (${unavailableReason})` : preset.label}
                data-launch-option={`preset:${preset.id}`}
                data-gesture-selected={selectedLaunchOption === `preset:${preset.id}` ? 'true' : undefined}
                aria-disabled={!isAvailable ? 'true' : undefined}
                disabled={!isAvailable}
                draggable={finePointer}
                onclick={(event) => onLaunchOptionClick(event, `preset:${preset.id}`)}
                ondragstart={(event) => onPresetDragStart(event, preset.id)}
                ondragover={(event) => onPresetDragOver(event, preset.id, event.currentTarget)}
                ondrop={(event) => onPresetDrop(event, preset.id)}
                ondragend={onPresetDragEnd}
              >
                {#if presetDrop?.id === preset.id && presetDrop.position === 'before'}
                  <span
                    class="pointer-events-none absolute top-1 bottom-1 left-0 z-10 w-0.5 rounded-full bg-primary"
                    aria-hidden="true"
                  ></span>
                {/if}
                {#if presetDrop?.id === preset.id && presetDrop.position === 'after'}
                  <span
                    class="pointer-events-none absolute top-1 right-0 bottom-1 z-10 w-0.5 rounded-full bg-primary"
                    aria-hidden="true"
                  ></span>
                {/if}
                <KindIcon kind={preset.provider} size={16} />
                <span class="truncate">{preset.label}</span>
              </Button>
            {/each}
          </div>
        </div>

        {#if usesDevicePlacement && devicePlan && devicePlan.action !== 'use-existing-location' && devicePlan.action !== 'use-device-directory' && pendingDeviceOption}
          <div class="border-t border-border p-2">
            <Button
              size="sm"
              class="h-8 w-full text-xs"
              disabled={!devicePlan.executable || launchingDevice}
              onclick={() => void prepareAndLaunch()}
            >
              {#if launchingDevice}<LoaderCircle class="size-3 animate-spin" />{/if}
              {devicePlan.action === 'clone-project' ? 'Clone to this device' : 'Create checkout'}
            </Button>
          </div>
        {/if}
      </div>
    </div>
  </Popover.Content>
</Popover.Root>
