<script lang="ts">
  import { PlugZap } from '@lucide/svelte';
  import { agentIntegrationSetup } from '../stores/agent-integration-setup.svelte';
  import { confirmStore } from '../stores/confirm.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import AgentIntegrationGrid from './AgentIntegrationGrid.svelte';

  let status = $derived(agentIntegrationSetup.status);

  let needsSetup = $derived.by(() => {
    if (!status) return false;
    return status.hosts.some(
      (h) => h.host.available && (!h.claude.current || !h.codex.current)
    );
  });

  function onOpenChange(next: boolean): void {
    if (!next) agentIntegrationSetup.close();
  }

  async function attemptSkip(): Promise<void> {
    if (!needsSetup) {
      agentIntegrationSetup.close();
      return;
    }
    const ok = await confirmStore.ask({
      title: 'Skip agent setup?',
      message:
        'Without hooks Soloe cannot bind Claude and Codex sessions to its tabs, so resume and live status will not work correctly until you connect each environment.',
      confirmLabel: 'Skip anyway',
      cancelLabel: 'Continue setup',
      tone: 'danger'
    });
    if (ok) agentIntegrationSetup.close();
  }
</script>

<Dialog.Root open={agentIntegrationSetup.open} {onOpenChange}>
  <Dialog.Content
    class="sm:max-w-lg"
    showCloseButton={!needsSetup}
    escapeKeydownBehavior={needsSetup ? 'ignore' : 'close'}
    interactOutsideBehavior={needsSetup ? 'ignore' : 'close'}
  >
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <PlugZap class="size-4 text-primary" />
        Agent setup
      </Dialog.Title>
      <Dialog.Description class="text-sm text-foreground">
        Connect Claude and Codex on each environment Soloe should observe. Hooks live in each
        environment's home directory and are not shared between Windows and WSL. Soloe will
        re-probe the WSL bridge URL on every launch and rewrite agent configs if it drifted (you
        can opt out in Settings → Integration).
      </Dialog.Description>
    </Dialog.Header>

    {#if status}
      <AgentIntegrationGrid {status} onChange={(next) => agentIntegrationSetup.update(next)} />
    {/if}

    <Dialog.Footer class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p class="m-0 text-[11px] text-muted-foreground">
        Manage anytime in Settings → Agent integration.
      </p>
      <Button variant="outline" onclick={attemptSkip}>
        {needsSetup ? 'Skip setup' : 'Done'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
