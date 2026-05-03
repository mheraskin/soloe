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
  let bulkBusy = $state(false);

  const availableHosts = $derived(status.hosts.filter((h) => h.host.available));
  const unavailableHosts = $derived(status.hosts.filter((h) => !h.host.available));

  const pendingActions = $derived.by(() =>
    availableHosts.flatMap((entry) => {
      const out: { host: AgentIntegrationHost; provider: Provider }[] = [];
      if (!entry.claude.current) out.push({ host: entry.host, provider: 'claude' });
      if (!entry.codex.current) out.push({ host: entry.host, provider: 'codex' });
      return out;
    })
  );

  const allInstalled = $derived(
    pendingActions.length > 0 &&
      pendingActions.every((a) =>
        a.provider === 'claude'
          ? availableHosts.find((h) => sameHost(h.host, a.host))?.claude.installed === true
          : availableHosts.find((h) => sameHost(h.host, a.host))?.codex.installed === true
      )
  );

  const bulkLabel = $derived(allInstalled ? 'Update everywhere' : 'Set up everywhere');

  function sameHost(a: AgentIntegrationHost, b: AgentIntegrationHost): boolean {
    return a.kind === b.kind && (a.kind === 'windows' || a.distro === b.distro);
  }

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

  async function install(host: AgentIntegrationHost, provider: Provider): Promise<AgentIntegrationStatus> {
    const args = { host: hostKey(host) };
    return provider === 'claude'
      ? await ipc.agentIntegration.installClaude(args)
      : await ipc.agentIntegration.installCodex(args);
  }

  async function uninstall(host: AgentIntegrationHost, provider: Provider): Promise<AgentIntegrationStatus> {
    const args = { host: hostKey(host) };
    return provider === 'claude'
      ? await ipc.agentIntegration.uninstallClaude(args)
      : await ipc.agentIntegration.uninstallCodex(args);
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
      const next = target.current ? await uninstall(host, provider) : await install(host, provider);
      onChange(next);
    } catch (err) {
      reportError(err);
    } finally {
      busy = { ...busy, [key]: false };
    }
  }

  async function setupEverywhere(): Promise<void> {
    if (bulkBusy || pendingActions.length === 0) return;
    bulkBusy = true;
    try {
      let next: AgentIntegrationStatus = status;
      for (const action of pendingActions) {
        next = await install(action.host, action.provider);
      }
      onChange(next);
    } catch (err) {
      reportError(err);
    } finally {
      bulkBusy = false;
    }
  }
</script>

{#snippet providerButton(
  host: AgentIntegrationHost,
  provider: Provider,
  target: AgentIntegrationTargetStatus
)}
  {@const isBusy = busy[busyKey(host, provider)] === true || bulkBusy}
  {@const label = providerLabel(provider)}
  {#if isBusy}
    <Button size="sm" variant="ghost" disabled class="h-7 min-w-[6rem] gap-1.5 px-2 text-[11px]">
      <Loader2 class="size-3 animate-spin" />
      Working…
    </Button>
  {:else if target.current}
    <Button
      size="sm"
      variant="ghost"
      class="h-7 min-w-[6rem] gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
      title={`Click to disconnect ${label}`}
      onclick={() => toggle(host, provider, target)}
    >
      <Check class="size-3 text-emerald-500" />
      {label}
    </Button>
  {:else if target.installed}
    <Button
      size="sm"
      variant="ghost"
      class="h-7 min-w-[6rem] gap-1.5 px-2 text-[11px] text-amber-200 hover:bg-amber-500/15 hover:text-amber-50"
      onclick={() => toggle(host, provider, target)}
    >
      <RefreshCw class="size-3" />
      Update {label}
    </Button>
  {:else}
    <Button
      size="sm"
      variant="ghost"
      class="h-7 min-w-[6rem] gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
      onclick={() => toggle(host, provider, target)}
    >
      Connect {label}
    </Button>
  {/if}
{/snippet}

<div class="flex flex-col gap-3">
  {#if pendingActions.length > 0}
    <Button
      size="default"
      class="w-full gap-2"
      disabled={bulkBusy}
      onclick={setupEverywhere}
    >
      {#if bulkBusy}
        <Loader2 class="size-4 animate-spin" />
        Setting up…
      {:else}
        <RefreshCw class="size-4" />
        {bulkLabel}
      {/if}
    </Button>
  {/if}

  <div class="flex flex-col">
    {#each availableHosts as entry, index (entryKey(entry))}
      <div
        class="flex flex-wrap items-center justify-between gap-2 py-1.5"
        class:border-t={index > 0}
        class:border-border={index > 0}
      >
        <div class="text-[11px] text-muted-foreground">{entry.host.label}</div>
        <div class="flex flex-wrap items-center gap-0.5">
          {@render providerButton(entry.host, 'claude', entry.claude)}
          {@render providerButton(entry.host, 'codex', entry.codex)}
        </div>
      </div>
    {/each}

    {#if unavailableHosts.length > 0}
      <div
        class="mt-1 flex flex-wrap items-center gap-1.5 pt-2 text-[11px] text-muted-foreground"
        class:border-t={availableHosts.length > 0}
        class:border-border={availableHosts.length > 0}
      >
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
</div>
