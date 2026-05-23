<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Plus } from '@lucide/svelte';
  import type { ProjectId } from '@shared/types/projects.js';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { QuickLaunchPreset } from '@shared/types/settings.js';
  import { sessions } from '../stores/sessions.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Popover from '$lib/components/ui/popover';
  import KindIcon from './KindIcon.svelte';

  const HOVER_OPEN_DELAY_MS = 250;
  const HOVER_CLOSE_DELAY_MS = 180;

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

  function scheduleOpen(): void {
    clearCloseTimer();
    if (open || openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      open = true;
    }, HOVER_OPEN_DELAY_MS);
  }

  function scheduleClose(): void {
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
    clearTimers();
    launchPreferred();
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
    const args: string[] = [];
    if (preset.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
    if (preset.extraArgs) {
      args.push(...preset.extraArgs.split(/\s+/).filter(Boolean));
    }
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

  let presets = $derived(settings.current.quickLaunch);

  onDestroy(clearTimers);
</script>

<Popover.Root bind:open {onOpenChange}>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class={`shrink-0 ${className}`}
        {title}
        aria-label={ariaLabel}
        onclick={onTriggerClick}
        onpointerenter={scheduleOpen}
        onpointerleave={scheduleClose}
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
    <div class="grid grid-cols-3 gap-1">
      <Button
        variant="ghost"
        class="h-14 flex-col gap-1 px-1 text-xs"
        title="New Claude session"
        aria-label="New Claude session"
        onclick={() => launchAgent('claude_code')}
      >
        <KindIcon kind="claude_code" size={20} />
        <span class="truncate leading-none">Claude</span>
      </Button>
      <Button
        variant="ghost"
        class="h-14 flex-col gap-1 px-1 text-xs"
        title="New Codex session"
        aria-label="New Codex session"
        onclick={() => launchAgent('codex')}
      >
        <KindIcon kind="codex" size={20} />
        <span class="truncate leading-none">Codex</span>
      </Button>
      <Button
        variant="ghost"
        class="h-14 flex-col gap-1 px-1 text-xs"
        title="New terminal"
        aria-label="New terminal"
        onclick={launchTerminal}
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
            class="h-7 w-full justify-start gap-2 px-2 text-xs"
            title={preset.label}
            aria-label={preset.label}
            onclick={() => launchPreset(preset)}
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
  </Popover.Content>
</Popover.Root>
