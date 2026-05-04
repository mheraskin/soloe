<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Plus } from '@lucide/svelte';
  import type { ProjectId } from '@shared/types/projects.js';
  import type { SessionKind } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Popover from '$lib/components/ui/popover';
  import KindIcon from './KindIcon.svelte';

  type AgentKind = Extract<SessionKind, 'claude_code' | 'codex'>;

  const HOVER_OPEN_DELAY_MS = 250;
  const HOVER_CLOSE_DELAY_MS = 180;

  let {
    projectId = null,
    cwd,
    branch,
    title = 'New session',
    ariaLabel = 'New session',
    class: className = ''
  }: {
    projectId?: ProjectId | null;
    cwd: string;
    branch?: string;
    title?: string;
    ariaLabel?: string;
    class?: string;
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
        cwd,
        ...(branch ? { branch } : {})
      })
      .catch(reportError);
  }

  function launchPreferred(): void {
    open = false;
    void sessions
      .createPreferredWithDefaults({
        ...(projectId ? { projectId } : {}),
        cwd,
        ...(branch ? { branch } : {})
      })
      .catch(reportError);
  }

  function launchAgent(kind: AgentKind): void {
    open = false;
    void sessions
      .createAgentWithDefaults(kind, {
        ...(projectId ? { projectId } : {}),
        cwd,
        ...(branch ? { branch } : {})
      })
      .catch(reportError);
  }

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
    align="end"
    side="right"
    sideOffset={8}
    class="z-40 w-44 rounded-md border-border bg-card p-1.5 shadow-md"
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
        <KindIcon kind="standard_terminal" size={20} />
        <span class="truncate leading-none">Terminal</span>
      </Button>
    </div>
  </Popover.Content>
</Popover.Root>
