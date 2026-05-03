<script lang="ts">
  import { Loader2 } from '@lucide/svelte';
  import type {
    AgentIntegrationHost,
    AgentIntegrationHostKey,
    AgentIntegrationStatus,
    AgentIntegrationTargetStatus
  } from '@shared/types/ipc.js';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';
  import { Checkbox } from '$lib/components/ui/checkbox';

  type Provider = 'claude' | 'codex';

  let {
    status,
    onChange
  }: {
    status: AgentIntegrationStatus;
    onChange: (next: AgentIntegrationStatus) => void;
  } = $props();

  let busy = $state<Record<string, boolean>>({});

  const hasStale = $derived.by(() =>
    status.hosts.some(
      (h) =>
        h.host.available &&
        ((h.claude.installed && !h.claude.current) || (h.codex.installed && !h.codex.current))
    )
  );

  function busyKey(host: AgentIntegrationHost, provider: Provider): string {
    return `${host.kind}:${host.distro ?? ''}:${provider}`;
  }

  function hostKey(host: AgentIntegrationHost): AgentIntegrationHostKey {
    if (host.kind === 'wsl' && host.distro) return { kind: 'wsl', distro: host.distro };
    return { kind: 'windows' };
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

<div class="flex flex-col gap-2">
  <div class="overflow-hidden rounded-md border border-border">
    <table class="w-full border-collapse text-xs">
      <thead>
        <tr class="bg-muted/40">
          <th
            scope="col"
            class="px-3 py-2 text-left text-[10px] font-medium tracking-widest text-muted-foreground uppercase"
          >
            Environment
          </th>
          <th
            scope="col"
            class="w-24 px-3 py-2 text-center text-[10px] font-medium tracking-widest text-muted-foreground uppercase"
          >
            Claude
          </th>
          <th
            scope="col"
            class="w-24 px-3 py-2 text-center text-[10px] font-medium tracking-widest text-muted-foreground uppercase"
          >
            Codex
          </th>
        </tr>
      </thead>
      <tbody>
        {#each status.hosts as entry (entry.host.kind + ':' + (entry.host.distro ?? ''))}
          <tr class="border-t border-border">
            <th scope="row" class="px-3 py-2.5 text-left align-middle font-normal">
              <div class="text-xs font-medium">{entry.host.label}</div>
              {#if !entry.host.available && entry.host.reason}
                <div class="mt-0.5 text-[11px] text-muted-foreground">{entry.host.reason}</div>
              {/if}
            </th>
            {#if !entry.host.available}
              <td
                colspan="2"
                class="px-3 py-2.5 text-center text-[11px] text-muted-foreground"
              >
                unavailable
              </td>
            {:else}
              {@const claudeBusy = busy[busyKey(entry.host, 'claude')] === true}
              {@const codexBusy = busy[busyKey(entry.host, 'codex')] === true}
              {@const claudeStale = entry.claude.installed && !entry.claude.current}
              {@const codexStale = entry.codex.installed && !entry.codex.current}
              <td class="px-3 py-2.5 text-center align-middle">
                {#if claudeBusy}
                  <Loader2 class="mx-auto size-4 animate-spin text-muted-foreground" />
                {:else}
                  <Checkbox
                    checked={entry.claude.current}
                    indeterminate={claudeStale}
                    aria-label={claudeStale
                      ? `Update Claude hooks on ${entry.host.label}`
                      : entry.claude.current
                        ? `Disconnect Claude from ${entry.host.label}`
                        : `Connect Claude on ${entry.host.label}`}
                    onCheckedChange={() => toggle(entry.host, 'claude', entry.claude)}
                    class={claudeStale
                      ? 'border-amber-500 data-[state=indeterminate]:bg-amber-500 data-[state=indeterminate]:text-white'
                      : ''}
                  />
                {/if}
              </td>
              <td class="px-3 py-2.5 text-center align-middle">
                {#if codexBusy}
                  <Loader2 class="mx-auto size-4 animate-spin text-muted-foreground" />
                {:else}
                  <Checkbox
                    checked={entry.codex.current}
                    indeterminate={codexStale}
                    aria-label={codexStale
                      ? `Update Codex hooks on ${entry.host.label}`
                      : entry.codex.current
                        ? `Disconnect Codex from ${entry.host.label}`
                        : `Connect Codex on ${entry.host.label}`}
                    onCheckedChange={() => toggle(entry.host, 'codex', entry.codex)}
                    class={codexStale
                      ? 'border-amber-500 data-[state=indeterminate]:bg-amber-500 data-[state=indeterminate]:text-white'
                      : ''}
                  />
                {/if}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if hasStale}
    <p class="m-0 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span aria-hidden="true" class="inline-block size-2 rounded-[3px] bg-amber-500"></span>
      Hooks installed but out of date — toggle to update.
    </p>
  {/if}
</div>
