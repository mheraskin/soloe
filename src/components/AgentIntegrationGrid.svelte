<script lang="ts">
  import { Check, Loader2, RefreshCw } from '@lucide/svelte';
  import type {
    AgentIntegrationHost,
    AgentIntegrationHostKey,
    AgentIntegrationHostStatus,
    AgentIntegrationStatus,
    AgentIntegrationTargetStatus
  } from '@shared/types/ipc.js';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';

  type Provider = 'claude' | 'codex';

  let {
    status,
    onChange
  }: {
    status: AgentIntegrationStatus;
    onChange: (next: AgentIntegrationStatus) => void;
  } = $props();

  let busy = $state<Record<string, boolean>>({});

  const availableHosts = $derived(status.hosts.filter((h) => h.host.available));
  const unavailableHosts = $derived(status.hosts.filter((h) => !h.host.available));

  function busyKey(host: AgentIntegrationHost, provider: Provider): string {
    return `${host.kind}:${host.distro ?? ''}:${provider}`;
  }

  function entryKey(entry: AgentIntegrationHostStatus): string {
    return entry.host.kind + ':' + (entry.host.distro ?? '');
  }

  function hostKey(host: AgentIntegrationHost): AgentIntegrationHostKey {
    if (host.kind === 'wsl' && host.distro) return { kind: 'wsl', distro: host.distro };
    return { kind: 'windows' };
  }

  function providerLabel(provider: Provider): string {
    return provider === 'claude' ? 'Claude' : 'Codex';
  }

  async function toggle(
    host: AgentIntegrationHost,
    provider: Provider,
    target: AgentIntegrationTargetStatus
  ): Promise<void> {
    const key = busyKey(host, provider);
    if (busy[key]) return;
    busy = { ...busy, [key]: true };
    try {
      const args = { host: hostKey(host) };
      const next = target.current
        ? provider === 'claude'
          ? await ipc.agentIntegration.uninstallClaude(args)
          : await ipc.agentIntegration.uninstallCodex(args)
        : provider === 'claude'
          ? await ipc.agentIntegration.installClaude(args)
          : await ipc.agentIntegration.installCodex(args);
      onChange(next);
    } catch (err) {
      reportError(err);
    } finally {
      busy = { ...busy, [key]: false };
    }
  }
</script>

{#snippet providerButton(
  host: AgentIntegrationHost,
  provider: Provider,
  target: AgentIntegrationTargetStatus
)}
  {@const isBusy = busy[busyKey(host, provider)] === true}
  {@const label = providerLabel(provider)}
  {#if isBusy}
    <Button size="sm" variant="outline" disabled class="min-w-[7.25rem] gap-1.5">
      <Loader2 class="size-3.5 animate-spin" />
      Working…
    </Button>
  {:else if target.current}
    <Button
      size="sm"
      variant="outline"
      class="min-w-[7.25rem] gap-1.5"
      title={`Click to disconnect ${label}`}
      onclick={() => toggle(host, provider, target)}
    >
      <Check class="size-3.5 text-emerald-500" />
      {label} connected
    </Button>
  {:else if target.installed}
    <Button
      size="sm"
      variant="outline"
      class="min-w-[7.25rem] gap-1.5 border-amber-500/60 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 hover:text-amber-50"
      onclick={() => toggle(host, provider, target)}
    >
      <RefreshCw class="size-3.5" />
      Update {label}
    </Button>
  {:else}
    <Button
      size="sm"
      class="min-w-[7.25rem]"
      onclick={() => toggle(host, provider, target)}
    >
      Connect {label}
    </Button>
  {/if}
{/snippet}

<div class="flex flex-col gap-2">
  {#each availableHosts as entry (entryKey(entry))}
    <div
      class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
    >
      <div class="text-xs font-medium">{entry.host.label}</div>
      <div class="flex flex-wrap items-center gap-2">
        {@render providerButton(entry.host, 'claude', entry.claude)}
        {@render providerButton(entry.host, 'codex', entry.codex)}
      </div>
    </div>
  {/each}

  {#if unavailableHosts.length > 0}
    <div class="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
      <span>Unavailable:</span>
      {#each unavailableHosts as entry (entryKey(entry))}
        <span
          class="rounded-sm bg-muted px-1.5 py-0.5"
          title={entry.host.reason ?? 'Not detected'}
        >
          {entry.host.label}
        </span>
      {/each}
    </div>
  {/if}
</div>
