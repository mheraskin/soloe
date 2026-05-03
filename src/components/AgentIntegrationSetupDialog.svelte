<script lang="ts">
  import { PlugZap, Settings as SettingsIcon } from '@lucide/svelte';
  import { agentIntegrationSetup } from '../stores/agent-integration-setup.svelte';
  import { settings } from '../stores/settings.svelte';
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

  function openSettings(): void {
    agentIntegrationSetup.close();
    settings.openDrawer();
  }
</script>

<Dialog.Root open={agentIntegrationSetup.open} {onOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <PlugZap class="size-4 text-primary" />
        Agent setup
      </Dialog.Title>
      <Dialog.Description class="text-sm text-foreground">
        Pick the environments where Soloe should install hooks for Claude and Codex. Hooks live in
        each environment's home directory and are not shared between Windows and WSL.
      </Dialog.Description>
    </Dialog.Header>

    {#if status}
      <AgentIntegrationGrid {status} onChange={(next) => agentIntegrationSetup.update(next)} />
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" onclick={openSettings}>
        <SettingsIcon />
        Settings
      </Button>
      <Button variant="outline" onclick={() => agentIntegrationSetup.close()}>
        {needsSetup ? 'Later' : 'Done'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
