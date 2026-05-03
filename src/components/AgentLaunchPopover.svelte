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

  function onTriggerClick(e: Event): void {
    e.stopPropagation();
    if (open) {
      launchTerminal();
    } else {
      open = true;
    }
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
