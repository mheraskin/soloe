<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Monitor, RefreshCw, SquareTerminal, Trash2, Wifi, WifiOff } from '@lucide/svelte';
  import type { ConnectionId, MachineConnection } from '@shared/types/connections.js';
  import { connections } from '../../stores/connections.svelte';
  import { cockpit } from '../../stores/cockpit.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import CockpitTerminalViewer from '../CockpitTerminalViewer.svelte';

  let endpoint = $state('');
  let adding = $state(false);
  let error = $state<string | null>(null);
  let attachedSessionKey = $state<string | null>(null);
  let attachedProjection = $derived(
    cockpit.snapshot.sessions.find((projection) => projection.key === attachedSessionKey) ?? null
  );

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
    if (!cockpit.loaded) void cockpit.load().catch(reportError);
  });

  async function add(): Promise<void> {
    if (!endpoint.trim() || adding) return;
    adding = true;
    error = null;
    try {
      await connections.add(endpoint);
      endpoint = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      adding = false;
    }
  }

  async function setEnabled(id: ConnectionId, enabled: boolean): Promise<void> {
    try {
      await connections.setEnabled(id, enabled);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function forget(id: ConnectionId): Promise<void> {
    try {
      await connections.remove(id);
    } catch (cause) {
      reportError(cause);
    }
  }

  function compatibilityLabel(machine: MachineConnection): string | null {
    if (!machine.compatibility) return null;
    if (machine.compatibility.status === 'compatible') {
      return `protocol v${machine.compatibility.negotiatedVersion}`;
    }
    return machine.compatibility.status === 'client-upgrade-required'
      ? 'desktop upgrade required'
      : 'device upgrade required';
  }

  async function toggleDeviceFilter(deviceId: string): Promise<void> {
    const current = cockpit.snapshot.filterDeviceIds;
    const next = current.includes(deviceId)
      ? current.filter((id) => id !== deviceId)
      : [...current, deviceId];
    await cockpit.setFilter(next);
  }
</script>

{#if !connections.supported}
  <div class="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
    Multi-Device connections are available in the Electron desktop application.
  </div>
{:else}
  <div class="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
    <div class="flex min-w-0 gap-2.5">
      {#if connections.snapshot.tailscale.state === 'connected'}
        <Wifi class="mt-0.5 size-4 shrink-0 text-success" />
      {:else}
        <WifiOff class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      {/if}
      <div class="min-w-0">
        <p class="m-0 text-xs font-medium">
          {connections.snapshot.tailscale.state === 'connected'
            ? `Tailscale connected${connections.snapshot.tailscale.tailnet ? ` · ${connections.snapshot.tailscale.tailnet}` : ''}`
            : 'Tailscale discovery unavailable'}
        </p>
        <p class="mt-1 mb-0 text-[11px] text-muted-foreground">
          {connections.snapshot.tailscale.message
            ?? 'Soloe probes online tailnet devices for a secure Tailscale Serve endpoint.'}
        </p>
      </div>
    </div>
    <Button
      variant="outline"
      size="sm"
      class="shrink-0 gap-1.5"
      disabled={connections.refreshing}
      onclick={() => void connections.refresh().catch(reportError)}
    >
      <RefreshCw class={`size-3.5 ${connections.refreshing ? 'motion-safe:animate-spin' : ''}`} />
      Refresh
    </Button>
  </div>

  <div class="flex flex-col gap-2">
    <div>
      <h3 class="m-0 text-xs font-medium">Devices</h3>
      <p class="mt-1 mb-0 text-[11px] text-muted-foreground">
        Enabled Devices stay connected concurrently. Disabling a Device releases only this cockpit's
        connection and never stops its running Sessions.
      </p>
    </div>
    {#each connections.snapshot.machines as machine (machine.id)}
      <div class="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Monitor class="size-4" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-xs font-medium">{machine.name}</span>
            {#if machine.active}
              <span class="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                Migrated default
              </span>
            {/if}
            {#if machine.enabled}
              <span class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                <Check class="size-2.5" /> Enabled
              </span>
            {/if}
          </div>
          <p class="mt-0.5 mb-0 truncate font-mono text-[10px] text-muted-foreground">
            {machine.id === 'local' ? 'This device' : machine.endpoint}
            {#if machine.id !== 'local'} · {machine.status}{/if}
          </p>
          {#if machine.deviceId}
            <p
              class={`mt-0.5 mb-0 truncate font-mono text-[10px] ${machine.trust === 'identity-mismatch' ? 'text-destructive' : 'text-muted-foreground'}`}
              title={`${machine.deviceId}${machine.capabilities?.length ? ` · ${machine.capabilities.join(', ')}` : ''}`}
            >
              Device {machine.deviceId.slice(0, 8)}
              {#if machine.trust === 'identity-mismatch'} · identity mismatch{/if}
              {#if compatibilityLabel(machine)} · {compatibilityLabel(machine)}{/if}
              {#if machine.capabilities?.length} · {machine.capabilities.length} capabilities{/if}
            </p>
          {:else if machine.id !== 'local'}
            <p class="mt-0.5 mb-0 text-[10px] text-muted-foreground">
              Legacy/provisional endpoint · authenticated identity not available
            </p>
          {/if}
        </div>
        {#if machine.id !== 'local'}
          <Button
            variant="outline"
            size="sm"
            disabled={!machine.enabled && (!machine.deviceId || machine.trust !== 'pinned' || machine.compatibility?.status !== 'compatible')}
            onclick={() => void setEnabled(machine.id, !machine.enabled)}
          >
            {machine.enabled ? 'Disable' : 'Enable'}
          </Button>
        {/if}
        {#if machine.id !== 'local' && !machine.active && !machine.enabled}
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:text-destructive"
            aria-label={`Forget ${machine.name}`}
            title={`Forget ${machine.name}`}
            onclick={() => void forget(machine.id)}
          >
            <Trash2 class="size-3.5" />
          </Button>
        {/if}
      </div>
    {/each}
  </div>

  {#if cockpit.supported && cockpit.loaded}
    <div class="flex flex-col gap-2 border-t border-border pt-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="m-0 text-xs font-medium">Sessions across Devices</h3>
          <p class="mt-1 mb-0 text-[11px] text-muted-foreground">
            Device filters change this view only. They do not disconnect a Device or stop its terminals.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={cockpit.refreshing}
          onclick={() => void cockpit.refresh().catch(reportError)}
        >
          <RefreshCw class={`size-3.5 ${cockpit.refreshing ? 'motion-safe:animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div class="flex flex-wrap gap-1.5" aria-label="Filter Sessions by Device">
        <Button
          variant={cockpit.snapshot.filterDeviceIds.length === 0 ? 'default' : 'outline'}
          size="xs"
          onclick={() => void cockpit.setFilter([]).catch(reportError)}
        >
          All Devices
        </Button>
        {#each cockpit.snapshot.devices as device (device.deviceId)}
          <Button
            variant={cockpit.snapshot.filterDeviceIds.includes(device.deviceId) ? 'default' : 'outline'}
            size="xs"
            aria-pressed={cockpit.snapshot.filterDeviceIds.includes(device.deviceId)}
            onclick={() => void toggleDeviceFilter(device.deviceId).catch(reportError)}
          >
            {device.name} · {device.state}
          </Button>
          {#if cockpit.snapshot.defaultPlacementDeviceId !== device.deviceId}
            <Button
              variant="ghost"
              size="xs"
              title={`Use ${device.name} for new Sessions by default`}
              onclick={() => void cockpit.setDefaultPlacement(device.deviceId).catch(reportError)}
            >
              Set default
            </Button>
          {/if}
        {/each}
      </div>

      <div class="max-h-64 overflow-y-auto rounded-md border border-border">
        {#if cockpit.visibleSessions.length === 0}
          <p class="m-0 p-3 text-[11px] text-muted-foreground">
            No Sessions are visible for the selected Devices.
          </p>
        {:else}
          {#each cockpit.visibleSessions as projection (projection.key)}
            <div class="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
              <Monitor class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate text-xs">{projection.session.name}</span>
              <span class="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                {projection.deviceName}
              </span>
              <span class="text-[10px] text-muted-foreground">
                {projection.runtime?.state.status ?? 'stopped'}
              </span>
              {#if projection.runtime?.terminalRef && projection.runtime.state.status === 'running'}
                <Button
                  variant={attachedSessionKey === projection.key ? 'default' : 'outline'}
                  size="xs"
                  class="gap-1"
                  onclick={() => {
                    attachedSessionKey = attachedSessionKey === projection.key
                      ? null
                      : projection.key;
                  }}
                >
                  <SquareTerminal class="size-3" />
                  {attachedSessionKey === projection.key ? 'Attached' : 'Attach'}
                </Button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>

      {#if attachedProjection}
        <CockpitTerminalViewer
          projection={attachedProjection}
          onClose={() => { attachedSessionKey = null; }}
        />
      {/if}
    </div>
  {/if}

  <div class="flex flex-col gap-1.5 border-t border-border pt-4">
    <Label class="text-xs" for="connection-endpoint">Add a Soloe machine</Label>
    <div class="flex gap-2">
      <Input
        id="connection-endpoint"
        bind:value={endpoint}
        placeholder="https://machine.tailnet-name.ts.net"
        spellcheck="false"
        autocomplete="off"
        onkeydown={(event) => {
          if (event.key === 'Enter') void add();
        }}
      />
      <Button disabled={!endpoint.trim() || adding} onclick={() => void add()}>
        {adding ? 'Checking…' : 'Add'}
      </Button>
    </div>
    <span class="text-[11px] text-muted-foreground">
      Enter the trusted HTTPS root shown by Tailscale Serve. Soloe tokens are never stored in this registry.
    </span>
    {#if error}<p class="m-0 text-[11px] text-destructive">{error}</p>{/if}
  </div>
{/if}
