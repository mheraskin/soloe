<script lang="ts">
  import { PlugZap, Settings as SettingsIcon } from '@lucide/svelte';
  import type { AgentIntegrationTargetStatus } from '@shared/types/ipc.js';
  import { ipc } from '../lib/ipc';
  import { agentIntegrationSetup } from '../stores/agent-integration-setup.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { settings } from '../stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';

  let claudeBusy = $state(false);
  let codexBusy = $state(false);

  let status = $derived(agentIntegrationSetup.status);
  let projectPath = $derived(agentIntegrationSetup.projectPath);
  let claudeProjectStatus = $derived.by<AgentIntegrationTargetStatus | null>(() => {
    if (!status || !projectPath) return null;
    if (status.claude.projectLocal.current || status.claude.projectLocal.installed) {
      return status.claude.projectLocal;
    }
    return status.claude.project;
  });
  let claudeStatus = $derived<AgentIntegrationTargetStatus | null>(
    claudeProjectStatus ?? status?.claude.user ?? null
  );
  let claudeNeedsSetup = $derived(
    Boolean(status && !status.claude.user.current && !claudeProjectStatus?.current)
  );
  let codexNeedsSetup = $derived(Boolean(status && !status.codex.current));
  let allCurrent = $derived(Boolean(status && !claudeNeedsSetup && !codexNeedsSetup));

  function onOpenChange(next: boolean): void {
    if (!next) agentIntegrationSetup.close();
  }

  function label(item: AgentIntegrationTargetStatus | null | undefined): string {
    if (!item?.installed) return 'Missing';
    if (!item.current) return 'Update needed';
    return 'Ready';
  }

  function tone(item: AgentIntegrationTargetStatus | null | undefined): string {
    if (item?.current) return 'text-emerald-500';
    if (item?.installed) return 'text-amber-500';
    return 'text-destructive';
  }

  async function installClaude(): Promise<void> {
    if (claudeBusy) return;
    claudeBusy = true;
    try {
      const next = await ipc.agentIntegration.installClaude({
        scope: 'user',
        projectPath
      });
      agentIntegrationSetup.update(next);
    } catch (err) {
      reportError(err);
    } finally {
      claudeBusy = false;
    }
  }

  async function installCodex(): Promise<void> {
    if (codexBusy) return;
    codexBusy = true;
    try {
      const next = await ipc.agentIntegration.installCodex();
      agentIntegrationSetup.update(next);
    } catch (err) {
      reportError(err);
    } finally {
      codexBusy = false;
    }
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
        Agent setup needed
      </Dialog.Title>
      <Dialog.Description class="text-sm text-foreground">
        Soloe needs Claude and Codex hooks to bind provider sessions to Soloe tabs. Without them,
        new agent sessions can start, but Soloe cannot reliably save the provider session id for
        resume.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-3 rounded-md border border-border p-3">
        <div class="min-w-0">
          <div class="text-sm font-medium">Claude Code</div>
          <div class="text-xs {tone(claudeStatus)}">{label(claudeStatus)}</div>
        </div>
        <Button size="sm" disabled={!claudeNeedsSetup || claudeBusy} onclick={installClaude}>
          {claudeBusy ? 'Working...' : claudeStatus?.installed ? 'Update' : 'Connect'}
        </Button>
      </div>

      <div class="flex items-center justify-between gap-3 rounded-md border border-border p-3">
        <div class="min-w-0">
          <div class="text-sm font-medium">Codex CLI</div>
          <div class="text-xs {tone(status?.codex)}">{label(status?.codex)}</div>
        </div>
        <Button size="sm" disabled={!codexNeedsSetup || codexBusy} onclick={installCodex}>
          {codexBusy ? 'Working...' : status?.codex.installed ? 'Update' : 'Connect'}
        </Button>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={openSettings}>
        <SettingsIcon />
        Settings
      </Button>
      <Button variant="outline" onclick={() => agentIntegrationSetup.close()}>
        {allCurrent ? 'Done' : 'Later'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
