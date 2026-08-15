<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ChevronLeft, Folder, LoaderCircle, Monitor, Plus } from '@lucide/svelte';
  import type { DeviceId } from '@shared/types/devices.js';
  import type { MultiDeviceSessionCreationPlan } from '@shared/types/multi-device-sessions.js';
  import type { SessionLaunch } from '@shared/types/sessions.js';
  import type { WorkspaceDirectoryListing } from '@shared/types/workspaces.js';
  import type { ProjectId } from '@shared/types/projects.js';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { QuickLaunchPreset } from '@shared/types/settings.js';
  import { sessions } from '../stores/sessions.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { quickLaunchExtraArgs } from '../lib/quick-launch';
  import { Button } from '$lib/components/ui/button';
  import * as Popover from '$lib/components/ui/popover';
  import * as Select from '$lib/components/ui/select';
  import { Input } from '$lib/components/ui/input';
  import KindIcon from './KindIcon.svelte';

  const HOVER_OPEN_DELAY_MS = 250;
  const HOVER_CLOSE_DELAY_MS = 180;
  const TOUCH_HOLD_OPEN_DELAY_MS = 350;

  type LaunchOption = AgentRuntimeProvider | 'terminal' | `preset:${string}`;

  let {
    projectId = null,
    cwd = undefined,
    branch,
    workspaceKey,
    defaultDeviceId = null,
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
    defaultDeviceId?: DeviceId | null;
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
  let selectedDeviceId = $state<DeviceId | null>(null);
  let devicePlan = $state<MultiDeviceSessionCreationPlan | null>(null);
  let devicePlanError = $state<string | null>(null);
  let planningDevice = $state(false);
  let launchingDevice = $state(false);
  let pendingDeviceOption = $state<LaunchOption | null>(null);
  let directoryListing = $state<WorkspaceDirectoryListing | null>(null);
  let browsingDirectories = $state(false);
  let folderName = $state('');
  let showLocationBrowser = $state(false);
  let planRequest = 0;

  let usesDevicePlacement = $derived(Boolean(workspaceKey && deviceSessions.supported));
  let selectedDevice = $derived(
    selectedDeviceId ? deviceSessions.device(selectedDeviceId) : null
  );
  let customTargetPath = $derived.by(() => {
    if (!directoryListing || !folderName.trim()) return undefined;
    return `${directoryListing.path}${directoryListing.path.endsWith(directoryListing.separator) ? '' : directoryListing.separator}${folderName.trim()}`;
  });

  $effect(() => {
    if (!open || !usesDevicePlacement || !workspaceKey) return;
    const availableIds = new Set(deviceSessions.state.devices.map((device) => device.deviceId));
    const preferred = defaultDeviceId && availableIds.has(defaultDeviceId)
      ? defaultDeviceId
      : deviceSessions.localDevice?.deviceId ?? deviceSessions.state.devices[0]?.deviceId ?? null;
    if (!selectedDeviceId || !availableIds.has(selectedDeviceId)) {
      selectedDeviceId = preferred;
      return;
    }
    const deviceId = selectedDeviceId;
    const targetPath = customTargetPath;
    void previewDevicePlan(deviceId, targetPath);
  });

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
    launchPreferred();
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
    selectedLaunchOption = launchOptionAtPoint(event.clientX, event.clientY);
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
    const option = launchOptionAtPoint(event.clientX, event.clientY) ?? selectedLaunchOption;
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
      pendingDeviceOption = null;
      showLocationBrowser = false;
      directoryListing = null;
    }
  }

  function launchForOption(option: LaunchOption): SessionLaunch {
    if (option === 'terminal') {
      return { type: 'terminal', shell: settings.current.defaults.shell };
    }
    if (option === 'claude_code' || option === 'codex') {
      return {
        type: 'agent',
        provider: option,
        resumeMode: 'new',
        ...(option === 'claude_code' ? { fullscreenTui: true } : {})
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
      workspaceKey: workspaceKey!,
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
      devicePlan = null;
      devicePlanError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === planRequest) planningDevice = false;
    }
  }

  async function launchOnDevice(option: LaunchOption): Promise<void> {
    if (!workspaceKey || !selectedDeviceId || launchingDevice) return;
    launchingDevice = true;
    devicePlanError = null;
    try {
      const plan = await deviceSessions.planCreate(deviceRequest(
        option,
        selectedDeviceId,
        customTargetPath
      ));
      devicePlan = plan;
      pendingDeviceOption = option;
      if (plan.action !== 'use-existing-location') return;
      await deviceSessions.executeCreate(plan.planId);
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
    try {
      await deviceSessions.executeCreate(devicePlan.planId);
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
    void sessions
      .createWithDefaults({
        ...(projectId ? { projectId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {})
      })
      .catch(reportError);
  }

  function launchPreferred(): void {
    if (usesDevicePlacement) {
      open = true;
      void launchOnDevice(preferredOption());
      return;
    }
    open = false;
    void sessions
      .createPreferredWithDefaults({
        ...(projectId ? { projectId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {})
      })
      .catch(reportError);
  }

  function launchAgent(kind: AgentRuntimeProvider): void {
    if (usesDevicePlacement) {
      void launchOnDevice(kind);
      return;
    }
    open = false;
    void sessions
      .createAgentWithDefaults(kind, {
        ...(projectId ? { projectId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {})
      })
      .catch(reportError);
  }

  function launchPreset(preset: QuickLaunchPreset): void {
    if (usesDevicePlacement) {
      void launchOnDevice(`preset:${preset.id}`);
      return;
    }
    open = false;
    const args = quickLaunchExtraArgs(preset);
    void sessions
      .createAgentWithDefaults(preset.provider, {
        ...(projectId ? { projectId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {}),
        ...(preset.model ? { model: preset.model } : {}),
        ...(args.length ? { extraArgs: args } : {})
      })
      .catch(reportError);
  }

  function launchOption(option: LaunchOption): void {
    if (option === 'terminal') {
      launchTerminal();
      return;
    }
    if (option === 'claude_code' || option === 'codex') {
      launchAgent(option);
      return;
    }
    const presetId = option.slice('preset:'.length);
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (preset) launchPreset(preset);
  }

  function onLaunchOptionClick(event: MouseEvent, option: LaunchOption): void {
    if (suppressNextClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressNextClick = false;
      clearSuppressClickTimer();
      return;
    }
    launchOption(option);
  }

  let presets = $derived(settings.current.quickLaunch);

  onDestroy(() => {
    clearTimers();
    clearTouchHoldTimer();
    clearSuppressClickTimer();
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
    class={`z-40 rounded-md border-border bg-card p-1.5 shadow-md ${usesDevicePlacement ? 'w-80' : 'w-48'}`}
    onpointerenter={clearCloseTimer}
    onpointerleave={scheduleClose}
  >
    <div bind:this={pickerEl}>
      {#if usesDevicePlacement}
        <div class="mb-1.5 flex flex-col gap-1.5 border-b border-border px-1 pb-2">
          <span class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Run on device</span>
          <Select.Root
            type="single"
            value={selectedDeviceId ?? undefined}
            onValueChange={(value) => {
              selectedDeviceId = value as DeviceId;
              pendingDeviceOption = null;
              directoryListing = null;
              showLocationBrowser = false;
              folderName = '';
            }}
          >
            <Select.Trigger class="h-8 w-full text-xs">
              <span class="flex min-w-0 items-center gap-2">
                <Monitor class="size-3.5 shrink-0" />
                <span class="truncate">{selectedDevice?.name ?? 'Choose device'}</span>
                {#if selectedDevice}
                  <span class={`ml-auto size-2 rounded-full ${selectedDevice.available ? 'bg-success' : 'bg-muted-foreground/50'}`}></span>
                {/if}
              </span>
            </Select.Trigger>
            <Select.Content>
              {#each deviceSessions.state.devices as device (device.deviceId)}
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

          {#if planningDevice}
            <p class="m-0 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LoaderCircle class="size-3 animate-spin" /> Checking workspace…
            </p>
          {:else if devicePlan}
            <div class="rounded border border-border bg-muted/25 p-2 text-[11px]">
              <p class="m-0 font-medium">
                {devicePlan.action === 'use-existing-location'
                  ? 'Workspace ready'
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
            </div>
          {:else if devicePlanError}
            <p class="m-0 text-[11px] text-destructive">{devicePlanError}</p>
          {/if}

          {#if devicePlan && devicePlan.action !== 'use-existing-location'}
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
      {/if}
      <div class="mobile-session-picker grid grid-cols-3 gap-1">
        <Button
          variant="ghost"
          class={`h-14 flex-col gap-1 px-1 text-xs ${selectedLaunchOption === 'claude_code' ? 'bg-muted text-foreground' : ''}`}
          title="New Claude session"
          aria-label="New Claude session"
          data-launch-option="claude_code"
          data-gesture-selected={selectedLaunchOption === 'claude_code' ? 'true' : undefined}
          onclick={(event) => onLaunchOptionClick(event, 'claude_code')}
        >
          <KindIcon kind="claude_code" size={20} />
          <span class="truncate leading-none">Claude</span>
        </Button>
        <Button
          variant="ghost"
          class={`h-14 flex-col gap-1 px-1 text-xs ${selectedLaunchOption === 'codex' ? 'bg-muted text-foreground' : ''}`}
          title="New Codex session"
          aria-label="New Codex session"
          data-launch-option="codex"
          data-gesture-selected={selectedLaunchOption === 'codex' ? 'true' : undefined}
          onclick={(event) => onLaunchOptionClick(event, 'codex')}
        >
          <KindIcon kind="codex" size={20} />
          <span class="truncate leading-none">Codex</span>
        </Button>
        <Button
          variant="ghost"
          class={`h-14 flex-col gap-1 px-1 text-xs ${selectedLaunchOption === 'terminal' ? 'bg-muted text-foreground' : ''}`}
          title="New terminal"
          aria-label="New terminal"
          data-launch-option="terminal"
          data-gesture-selected={selectedLaunchOption === 'terminal' ? 'true' : undefined}
          onclick={(event) => onLaunchOptionClick(event, 'terminal')}
        >
          <KindIcon kind="terminal" size={20} />
          <span class="truncate leading-none">Terminal</span>
        </Button>
      </div>
      {#if presets.length > 0}
        <div class="my-1 border-t border-border"></div>
        <div class="flex flex-col gap-0.5">
          {#each presets as preset (preset.id)}
            <Button
              variant="ghost"
              class={`h-7 w-full justify-start gap-2 px-2 text-xs ${selectedLaunchOption === `preset:${preset.id}` ? 'bg-muted text-foreground' : ''}`}
              title={preset.label}
              aria-label={preset.label}
              data-launch-option={`preset:${preset.id}`}
              data-gesture-selected={selectedLaunchOption === `preset:${preset.id}` ? 'true' : undefined}
              onclick={(event) => onLaunchOptionClick(event, `preset:${preset.id}`)}
            >
              <KindIcon
                kind={preset.provider === 'claude_code' ? 'claude_code' : 'codex'}
                size={14}
              />
              <span class="truncate">{preset.label}</span>
            </Button>
          {/each}
        </div>
      {/if}
      {#if usesDevicePlacement && devicePlan && devicePlan.action !== 'use-existing-location' && pendingDeviceOption}
        <div class="mt-1.5 border-t border-border pt-1.5">
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
  </Popover.Content>
</Popover.Root>
