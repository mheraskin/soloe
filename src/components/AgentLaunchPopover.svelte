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
  import { Plus } from '@lucide/svelte';
  import type { ProjectId } from '@shared/types/projects.js';
  import type { SessionKind } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Popover from '$lib/components/ui/popover';
  import KindIcon from './KindIcon.svelte';

  type AgentKind = Extract<SessionKind, 'claude_code' | 'codex'>;

  let {
    projectId = null,
    cwd,
    branch,
    title = 'New terminal',
    ariaLabel = 'New terminal',
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

  function closeSelf(): void {
    open = false;
    clearActivePopover(closeSelf);
  }

  function requestOpen(): void {
    setActivePopover(closeSelf);
    open = true;
  }

  function launchTerminal(e: Event): void {
    e.stopPropagation();
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
        onpointerenter={requestOpen}
        onfocus={requestOpen}
        onclick={launchTerminal}
      >
        <Plus />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    align="end"
    side="right"
    sideOffset={8}
    class="w-40 rounded-md border-border bg-card p-1.5 shadow-md"
    onpointerdown={(e) => e.stopPropagation()}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="grid grid-cols-2 gap-1">
      <Button
        variant="ghost"
        class="h-12 flex-col gap-1 px-1.5 text-xs"
        title="New Claude session"
        aria-label="New Claude session"
        onclick={() => launchAgent('claude_code')}
      >
        <KindIcon kind="claude_code" size={20} />
        <span class="truncate leading-none">Claude</span>
      </Button>
      <Button
        variant="ghost"
        class="h-12 flex-col gap-1 px-1.5 text-xs"
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
