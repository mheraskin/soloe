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

  function launchTerminal(e: Event): void {
    e.stopPropagation();
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
        onpointerenter={() => (open = true)}
        onfocus={() => (open = true)}
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
    class="w-56 gap-2 p-2"
    onpointerdown={(e) => e.stopPropagation()}
    onclick={(e) => e.stopPropagation()}
  >
    <Button
      variant="outline"
      class="h-14 w-full justify-start gap-3 px-3 text-left"
      onclick={() => launchAgent('claude_code')}
    >
      <KindIcon kind="claude_code" size={24} />
      <span class="flex min-w-0 flex-col leading-tight">
        <span class="truncate text-sm font-semibold">Claude</span>
        <span class="truncate text-[11px] text-muted-foreground">New Claude session</span>
      </span>
    </Button>
    <Button
      variant="outline"
      class="h-14 w-full justify-start gap-3 px-3 text-left"
      onclick={() => launchAgent('codex')}
    >
      <KindIcon kind="codex" size={24} />
      <span class="flex min-w-0 flex-col leading-tight">
        <span class="truncate text-sm font-semibold">Codex</span>
        <span class="truncate text-[11px] text-muted-foreground">New Codex session</span>
      </span>
    </Button>
  </Popover.Content>
</Popover.Root>
