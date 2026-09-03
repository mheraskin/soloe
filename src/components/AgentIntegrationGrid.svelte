<script lang="ts">
  import { Check, Loader2, RefreshCw } from '@lucide/svelte';
  import type {
    AgentIntegrationHost,
    AgentIntegrationHostKey,
    AgentIntegrationHostStatus,
    AgentIntegrationStatus,
    AgentIntegrationTargetStatus
  } from '@shared/types/ipc.js';
  import { agentIntegrationHostKey } from '../lib/platform-ui';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';

  type Provider = 'claude' | 'codex' | 'cursor' | 'opencode' | 'grok';

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
      if (!entry.cursor.current) out.push({ host: entry.host, provider: 'cursor' });
      if (!entry.opencode.current) out.push({ host: entry.host, provider: 'opencode' });
      if (!entry.grok.current) out.push({ host: entry.host, provider: 'grok' });
      return out;
    })
  );

  const installedActions = $derived.by(() =>
    availableHosts.flatMap((entry) => {
      const out: { host: AgentIntegrationHost; provider: Provider }[] = [];
      if (entry.claude.installed) out.push({ host: entry.host, provider: 'claude' });
      if (entry.codex.installed) out.push({ host: entry.host, provider: 'codex' });
      if (entry.cursor.installed) out.push({ host: entry.host, provider: 'cursor' });
      if (entry.opencode.installed) out.push({ host: entry.host, provider: 'opencode' });
      if (entry.grok.installed) out.push({ host: entry.host, provider: 'grok' });
      return out;
    })
  );

  const pendingActionsAreInstalled = $derived(
    pendingActions.length > 0 &&
      pendingActions.every((a) =>
        a.provider === 'claude'
          ? availableHosts.find((h) => sameHost(h.host, a.host))?.claude.installed === true
          : a.provider === 'codex'
            ? availableHosts.find((h) => sameHost(h.host, a.host))?.codex.installed === true
            : a.provider === 'cursor'
              ? availableHosts.find((h) => sameHost(h.host, a.host))?.cursor.installed === true
              : a.provider === 'opencode'
                ? availableHosts.find((h) => sameHost(h.host, a.host))?.opencode.installed === true
                : availableHosts.find((h) => sameHost(h.host, a.host))?.grok.installed === true
      )
  );

  // When every integration is current, there are no pending actions to drive
  // the bulk control. Fall back to all installed targets so the same control
  // can refresh their MCP URLs and hooks in one click.
  const bulkActions = $derived(pendingActions.length > 0 ? pendingActions : installedActions);
  const bulkLabel = $derived(
    pendingActions.length === 0 || pendingActionsAreInstalled
      ? 'Update everywhere'
      : 'Set up everywhere'
  );
  const bulkBusyLabel = $derived(
    bulkLabel === 'Update everywhere' ? 'Updating…' : 'Setting up…'
  );

  function sameHost(a: AgentIntegrationHost, b: AgentIntegrationHost): boolean {
    return a.kind === b.kind && (a.kind !== 'wsl' || a.distro === b.distro);
  }

  function busyKey(host: AgentIntegrationHost, provider: Provider): string {
    return `${host.kind}:${host.distro ?? ''}:${provider}`;
  }

  function entryKey(entry: AgentIntegrationHostStatus): string {
    return entry.host.kind + ':' + (entry.host.distro ?? '');
  }

  function hostKey(host: AgentIntegrationHost): AgentIntegrationHostKey {
    return agentIntegrationHostKey(host);
  }

  function providerLabel(provider: Provider): string {
    return provider === 'claude'
      ? 'Claude'
      : provider === 'codex'
        ? 'Codex'
        : provider === 'cursor'
          ? 'Cursor'
          : provider === 'opencode' ? 'OpenCode' : 'Grok Build';
  }

  async function install(host: AgentIntegrationHost, provider: Provider): Promise<AgentIntegrationStatus> {
    const args = { host: hostKey(host) };
    if (provider === 'claude') return ipc.agentIntegration.installClaude(args);
    if (provider === 'codex') return ipc.agentIntegration.installCodex(args);
    if (provider === 'cursor') return ipc.agentIntegration.installCursor(args);
    if (provider === 'opencode') return ipc.agentIntegration.installOpenCode(args);
    return ipc.agentIntegration.installGrok(args);
  }

  async function uninstall(host: AgentIntegrationHost, provider: Provider): Promise<AgentIntegrationStatus> {
    const args = { host: hostKey(host) };
    if (provider === 'claude') return ipc.agentIntegration.uninstallClaude(args);
    if (provider === 'codex') return ipc.agentIntegration.uninstallCodex(args);
    if (provider === 'cursor') return ipc.agentIntegration.uninstallCursor(args);
    if (provider === 'opencode') return ipc.agentIntegration.uninstallOpenCode(args);
    return ipc.agentIntegration.uninstallGrok(args);
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
    if (bulkBusy || bulkActions.length === 0) return;
    bulkBusy = true;
    try {
      let next: AgentIntegrationStatus = status;
      for (const action of bulkActions) {
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
  {@const cli = target.cli}
  {@const cliTitle = cli
    ? cli.available
      ? `CLI: ${cli.binary ?? label}${cli.version ? ` ${cli.version}` : ''}`
      : (cli.reason ?? `${label} CLI missing`)
    : undefined}
  {#if isBusy}
    <Button size="sm" variant="ghost" disabled class="h-7 min-w-[6rem] gap-1.5 px-2 text-[11px]">
      <Loader2 class="size-3 animate-spin" />
      Working…
    </Button>
  {:else if target.current}
    <Button
      size="sm"
      variant="ghost"
      class={`h-7 min-w-[6rem] gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground ${cli && !cli.available ? 'opacity-60' : ''}`}
      title={cliTitle ?? `Click to disconnect ${label}`}
      onclick={() => toggle(host, provider, target)}
    >
      <Check class="size-3 text-emerald-500" />
      {label}
      {#if cli && !cli.available}
        <span class="text-[9px] text-amber-500">CLI</span>
      {/if}
    </Button>
  {:else if target.installed}
    <Button
      size="sm"
      variant="ghost"
      class={`h-7 min-w-[6rem] gap-1.5 px-2 text-[11px] text-amber-200 hover:bg-amber-500/15 hover:text-amber-50 ${cli && !cli.available ? 'opacity-60' : ''}`}
      title={cliTitle}
      onclick={() => toggle(host, provider, target)}
    >
      <RefreshCw class="size-3" />
      Update {label}
    </Button>
  {:else}
    <Button
      size="sm"
      variant="ghost"
      class={`h-7 min-w-[6rem] gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground ${cli && !cli.available ? 'opacity-60' : ''}`}
      title={cliTitle}
      onclick={() => toggle(host, provider, target)}
    >
      Connect {label}
      {#if cli && !cli.available}
        <span class="text-[9px] text-amber-500">CLI</span>
      {/if}
    </Button>
  {/if}
{/snippet}

<div class="flex flex-col gap-3">
  {#if bulkActions.length > 0}
    <Button
      size="default"
      class="w-full gap-2"
      disabled={bulkBusy}
      onclick={setupEverywhere}
    >
      {#if bulkBusy}
        <Loader2 data-icon="inline-start" class="animate-spin" />
        {bulkBusyLabel}
      {:else}
        <RefreshCw data-icon="inline-start" />
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
          {@render providerButton(entry.host, 'cursor', entry.cursor)}
          {@render providerButton(entry.host, 'opencode', entry.opencode)}
          {@render providerButton(entry.host, 'grok', entry.grok)}
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
