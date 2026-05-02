<script lang="ts" module>
  let closeActivePopover: (() => void) | null = null;

  function setActivePopover(close: () => void): void {
    if (closeActivePopover && closeActivePopover !== close) closeActivePopover();
    closeActivePopover = close;
  }

  function clearActivePopover(close: () => void): void {
    if (closeActivePopover === close) closeActivePopover = null;
  }
</script>

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

  function clearTimers(): void {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function closeSelf(): void {
    clearTimers();
    open = false;
    clearActivePopover(closeSelf);
  }

  function openNow(): void {
    clearTimers();
    setActivePopover(closeSelf);
    open = true;
  }

  function scheduleOpen(): void {
    if (open) {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      return;
    }
    if (openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      openNow();
    }, HOVER_OPEN_DELAY_MS);
  }

  function scheduleClose(): void {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (!open || closeTimer) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      closeSelf();
    }, HOVER_CLOSE_DELAY_MS);
  }

  function onTriggerClick(e: Event): void {
    e.stopPropagation();
    if (open) {
      closeSelf();
    } else {
      openNow();
    }
  }

  function launchTerminal(): void {
    closeSelf();
    void sessions
      .createWithDefaults({
        ...(projectId ? { projectId } : {}),
        cwd,
        ...(branch ? { branch } : {})
      })
      .catch(reportError);
  }

  function launchAgent(kind: AgentKind): void {
    closeSelf();
    void sessions
      .createAgentWithDefaults(kind, {
        ...(projectId ? { projectId } : {}),
        cwd,
        ...(branch ? { branch } : {})
      })
      .catch(reportError);
  }

  onDestroy(() => {
    clearTimers();
  });
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class={`shrink-0 ${className}`}
        {title}
        aria-label={ariaLabel}
        onpointerenter={scheduleOpen}
        onpointerleave={scheduleClose}
        onfocus={openNow}
        onclick={onTriggerClick}
      >
        <Plus />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    align="end"
    side="right"
    sideOffset={8}
    class="w-44 rounded-md border-border bg-card p-1.5 shadow-md"
    onpointerenter={() => {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    }}
    onpointerleave={scheduleClose}
    onpointerdown={(e) => e.stopPropagation()}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="grid grid-cols-3 gap-1">
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
    </div>
  </Popover.Content>
</Popover.Root>
