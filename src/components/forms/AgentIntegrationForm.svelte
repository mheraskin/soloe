<script lang="ts">
  import { onMount } from 'svelte';
  import { ipc } from '../../lib/ipc';
  import { reportError } from '../../stores/toast.svelte';
  import type {
    AgentIntegrationHost,
    AgentIntegrationHostKey,
    AgentIntegrationStatus,
    AgentIntegrationTargetStatus
  } from '@shared/types/ipc.js';
  import { Button } from '$lib/components/ui/button';

  let status = $state<AgentIntegrationStatus | null>(null);
  let busy = $state<Record<string, boolean>>({});

  async function refresh() {
    try {
      status = await ipc.agentIntegration.status();
    } catch (e) {
      reportError(e);
    }
  }

  onMount(() => {
    void refresh();
    const off = ipc.agentIntegration.onChange((s) => {
      status = s;
    });
    return off;
  });

  function hostKey(host: AgentIntegrationHost): AgentIntegrationHostKey {
    if (host.kind === 'wsl' && host.distro) return { kind: 'wsl', distro: host.distro };
    return { kind: 'windows' };
  }

  function busyKeyFor(host: AgentIntegrationHost, provider: 'claude' | 'codex'): string {
    return `${host.kind}:${host.distro ?? ''}:${provider}`;
  }

  function statusLabel(item: AgentIntegrationTargetStatus | null | undefined): string {
    if (!item?.installed) return 'Not connected';
    if (!item.current) return 'Update needed';
    return 'Connected';
  }

  function statusClass(item: AgentIntegrationTargetStatus | null | undefined): string {
    if (item?.current) return 'text-emerald-500';
    if (item?.installed) return 'text-amber-500';
    return 'text-muted-foreground';
  }

  async function withBusy(
    key: string,
    action: () => Promise<AgentIntegrationStatus>
  ): Promise<void> {
    if (busy[key]) return;
    busy = { ...busy, [key]: true };
    try {
      status = await action();
    } catch (e) {
      reportError(e);
    } finally {
      busy = { ...busy, [key]: false };
    }
  }

  function installClaude(host: AgentIntegrationHost): Promise<void> {
    return withBusy(busyKeyFor(host, 'claude'), () =>
      ipc.agentIntegration.installClaude({ host: hostKey(host) })
    );
  }

  function uninstallClaude(host: AgentIntegrationHost): Promise<void> {
    return withBusy(busyKeyFor(host, 'claude'), () =>
      ipc.agentIntegration.uninstallClaude({ host: hostKey(host) })
    );
  }

  function installCodex(host: AgentIntegrationHost): Promise<void> {
    return withBusy(busyKeyFor(host, 'codex'), () =>
      ipc.agentIntegration.installCodex({ host: hostKey(host) })
    );
  }

  function uninstallCodex(host: AgentIntegrationHost): Promise<void> {
    return withBusy(busyKeyFor(host, 'codex'), () =>
      ipc.agentIntegration.uninstallCodex({ host: hostKey(host) })
    );
  }

  const needsSetup = $derived.by(() => {
    if (!status) return false;
    return status.hosts.some(
      (h) => h.host.available && (!h.claude.current || !h.codex.current)
    );
  });
</script>

<div class="flex flex-col gap-4">
  {#if needsSetup}
    <div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
      Agent hooks are missing or out of date on at least one environment. Connect or update each
      target so Soloe can bind Claude and Codex sessions for correct resume.
    </div>
  {/if}

  {#if status}
    {#each status.hosts as entry (entry.host.kind + ':' + (entry.host.distro ?? ''))}
      {@const claudeBusy = busy[busyKeyFor(entry.host, 'claude')] === true}
      {@const codexBusy = busy[busyKeyFor(entry.host, 'codex')] === true}
      <div class="flex flex-col gap-2.5 rounded-md border border-border p-3">
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
              <div class="text-xs font-medium">Claude Code</div>
              <div class="text-[10px] tracking-widest uppercase {statusClass(entry.claude)}">
                {statusLabel(entry.claude)}
              </div>
              <div class="text-[11px] text-muted-foreground">
                {entry.host.kind === 'wsl'
                  ? `~/.claude/settings.json on ${entry.host.distro}`
                  : '~/.claude/settings.json'}
              </div>
            </div>
            {#if entry.claude.installed}
              <div class="flex gap-2">
                {#if !entry.claude.current}
                  <Button size="sm" disabled={claudeBusy} onclick={() => installClaude(entry.host)}>
                    {claudeBusy ? 'Working…' : 'Update'}
                  </Button>
                {/if}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={claudeBusy}
                  onclick={() => uninstallClaude(entry.host)}
                >
                  {claudeBusy ? 'Working…' : 'Disconnect'}
                </Button>
              </div>
            {:else}
              <Button size="sm" disabled={claudeBusy} onclick={() => installClaude(entry.host)}>
                {claudeBusy ? 'Working…' : 'Connect'}
              </Button>
            {/if}
          </div>

          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-xs font-medium">Codex CLI</div>
              <div class="text-[10px] tracking-widest uppercase {statusClass(entry.codex)}">
                {statusLabel(entry.codex)}
              </div>
              <div class="text-[11px] text-muted-foreground">
                {entry.host.kind === 'wsl'
                  ? `~/.codex/config.toml on ${entry.host.distro}`
                  : '~/.codex/config.toml'}
              </div>
            </div>
            {#if entry.codex.installed}
              <div class="flex gap-2">
                {#if !entry.codex.current}
                  <Button size="sm" disabled={codexBusy} onclick={() => installCodex(entry.host)}>
                    {codexBusy ? 'Working…' : 'Update'}
                  </Button>
                {/if}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={codexBusy}
                  onclick={() => uninstallCodex(entry.host)}
                >
                  {codexBusy ? 'Working…' : 'Disconnect'}
                </Button>
              </div>
            {:else}
              <Button size="sm" disabled={codexBusy} onclick={() => installCodex(entry.host)}>
                {codexBusy ? 'Working…' : 'Connect'}
              </Button>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
