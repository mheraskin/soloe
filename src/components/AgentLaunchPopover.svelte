<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Plus } from '@lucide/svelte';
  import type { ProjectId } from '@shared/types/projects.js';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { QuickLaunchPreset } from '@shared/types/settings.js';
  import { sessions } from '../stores/sessions.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { quickLaunchExtraArgs } from '../lib/quick-launch';
  import { Button } from '$lib/components/ui/button';
  import * as Popover from '$lib/components/ui/popover';
  import KindIcon from './KindIcon.svelte';

  const HOVER_OPEN_DELAY_MS = 250;
  const HOVER_CLOSE_DELAY_MS = 180;
  const TOUCH_HOLD_OPEN_DELAY_MS = 350;

  type LaunchOption = AgentRuntimeProvider | 'terminal' | `preset:${string}`;

  let {
    projectId = null,
    cwd = undefined,
    branch,
    title = 'New session',
    ariaLabel = 'New session',
    class: className = '',
    side = 'right',
    align = 'start'
  }: {
    projectId?: ProjectId | null;
    cwd?: string;
    branch?: string;
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
  }

  function launchTerminal(): void {
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
    class="z-40 w-48 rounded-md border-border bg-card p-1.5 shadow-md"
    onpointerenter={clearCloseTimer}
    onpointerleave={scheduleClose}
  >
    <div bind:this={pickerEl}>
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
    </div>
  </Popover.Content>
</Popover.Root>
