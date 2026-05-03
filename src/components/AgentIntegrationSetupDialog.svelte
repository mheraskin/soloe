<script lang="ts">
  import { PlugZap, Settings as SettingsIcon } from '@lucide/svelte';
  import type {
    AgentIntegrationHost,
    AgentIntegrationHostKey,
    AgentIntegrationTargetStatus
  } from '@shared/types/ipc.js';
  import { ipc } from '../lib/ipc';
  import { agentIntegrationSetup } from '../stores/agent-integration-setup.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { settings } from '../stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';

  let busy = $state<Record<string, boolean>>({});

  let status = $derived(agentIntegrationSetup.status);

  let needsSetup = $derived.by(() => {
    if (!status) return false;
    return status.hosts.some(
      (h) => h.host.available && (!h.claude.current || !h.codex.current)
    );
  });

  function busyKey(host: AgentIntegrationHost, provider: 'claude' | 'codex'): string {
    return `${host.kind}:${host.distro ?? ''}:${provider}`;
  }

  function hostKey(host: AgentIntegrationHost): AgentIntegrationHostKey {
    if (host.kind === 'wsl' && host.distro) return { kind: 'wsl', distro: host.distro };
    return { kind: 'windows' };
  }

  function onOpenChange(next: boolean): void {
    if (!next) agentIntegrationSetup.close();
  }

  function label(item: AgentIntegrationTargetStatus): string {
    if (!item.installed) return 'Missing';
    if (!item.current) return 'Update needed';
    return 'Ready';
  }

  function tone(item: AgentIntegrationTargetStatus): string {
    if (item.current) return 'text-emerald-500';
    if (item.installed) return 'text-amber-500';
    return 'text-destructive';
  }

  async function installClaude(host: AgentIntegrationHost): Promise<void> {
    const key = busyKey(host, 'claude');
    if (busy[key]) return;
    busy = { ...busy, [key]: true };
    try {
      const next = await ipc.agentIntegration.installClaude({ host: hostKey(host) });
      agentIntegrationSetup.update(next);
    } catch (err) {
      reportError(err);
    } finally {
      busy = { ...busy, [key]: false };
    }
  }

  async function installCodex(host: AgentIntegrationHost): Promise<void> {
    const key = busyKey(host, 'codex');
    if (busy[key]) return;
    busy = { ...busy, [key]: true };
    try {
      const next = await ipc.agentIntegration.installCodex({ host: hostKey(host) });
      agentIntegrationSetup.update(next);
    } catch (err) {
      reportError(err);
    } finally {
      busy = { ...busy, [key]: false };
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
        Install hooks on every environment that runs Claude or Codex so Soloe can bind provider
        sessions to its tabs. Hooks live in each environment's home directory and are not shared
        between Windows and WSL.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-3">
      {#if status}
        {#each status.hosts as entry (entry.host.kind + ':' + (entry.host.distro ?? ''))}
          {@const claudeKey = busyKey(entry.host, 'claude')}
          {@const codexKey = busyKey(entry.host, 'codex')}
          <div class="flex flex-col gap-2 rounded-md border border-border p-3">
            <div class="flex items-baseline justify-between gap-2">
              <h4 class="m-0 text-xs font-semibold">{entry.host.label}</h4>
              {#if !entry.host.available}
                <span class="text-[10px] tracking-widest text-muted-foreground uppercase">
                  Unavailable
                </span>
              {/if}
            </div>
            {#if !entry.host.available}
              <p class="m-0 text-[11px] text-muted-foreground">
                {entry.host.reason ?? 'Distro could not be detected.'}
              </p>
            {:else}
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm">Claude Code</div>
                  <div class="text-xs {tone(entry.claude)}">{label(entry.claude)}</div>
                </div>
                <Button
                  size="sm"
                  disabled={busy[claudeKey] || entry.claude.current}
                  onclick={() => installClaude(entry.host)}
                >
                  {busy[claudeKey]
                    ? 'Working…'
                    : entry.claude.current
                      ? 'Connected'
                      : entry.claude.installed
                        ? 'Update'
                        : 'Connect'}
                </Button>
              </div>
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm">Codex CLI</div>
                  <div class="text-xs {tone(entry.codex)}">{label(entry.codex)}</div>
                </div>
                <Button
                  size="sm"
                  disabled={busy[codexKey] || entry.codex.current}
                  onclick={() => installCodex(entry.host)}
                >
                  {busy[codexKey]
                    ? 'Working…'
                    : entry.codex.current
                      ? 'Connected'
                      : entry.codex.installed
                        ? 'Update'
                        : 'Connect'}
                </Button>
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

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
