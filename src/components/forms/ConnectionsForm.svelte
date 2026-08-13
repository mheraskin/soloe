<script lang="ts">
  import { onMount } from 'svelte';
  import { CircleAlert, ExternalLink, Monitor, RefreshCw, Wifi, WifiOff } from '@lucide/svelte';
  import type { MachineConnection } from '@shared/types/connections.js';
  import { connections } from '../../stores/connections.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { ipc } from '../../lib/ipc';
  import { Button } from '$lib/components/ui/button';

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
  });

  let tailscaleReady = $derived(
    connections.snapshot.tailscale.state === 'connected'
      && connections.snapshot.tailscale.sharing.state === 'ready'
  );
  let visibleMachines = $derived(
    connections.snapshot.tailscale.state === 'connected'
      ? connections.snapshot.machines.filter((machine) =>
          machine.id !== 'local' && machine.source === 'discovered'
        )
      : []
  );

  function machineStatus(machine: MachineConnection): {
    label: string;
    tone: 'online' | 'offline' | 'update';
  } {
    if (
      !machine.deviceId
      || machine.updateRequired
      || machine.compatibility?.status === 'device-upgrade-required'
      || machine.compatibility?.status === 'client-upgrade-required'
    ) {
      return { label: 'Update Soloe', tone: 'update' };
    }
    if (machine.status === 'available' && machine.trust === 'pinned') {
      return { label: 'Online', tone: 'online' };
    }
    return { label: 'Offline', tone: 'offline' };
  }

  function setupTitle(): string {
    const network = connections.snapshot.tailscale.state;
    const sharing = connections.snapshot.tailscale.sharing.state;
    if (network === 'unavailable') return 'Install Tailscale to connect devices';
    if (network === 'not-running') return 'Sign in to Tailscale';
    if (sharing === 'setup-required') return 'Approve Soloe device sharing';
    if (sharing === 'conflict') return 'Tailscale port needs attention';
    if (network === 'connected' && sharing === 'ready') return 'Device connections are ready';
    return 'Tailscale connection needs attention';
  }

  function setupMessage(): string {
    const tailscale = connections.snapshot.tailscale;
    if (tailscale.state === 'unavailable') {
      return 'Soloe works locally without Tailscale. Install it only when you want to use Sessions on other machines.';
    }
    if (tailscale.state === 'not-running') {
      return 'Open the Tailscale app and sign in. Return here and refresh; Soloe does not need to restart.';
    }
    if (tailscale.sharing.state === 'ready') {
      return `Soloe automatically shares this machine and discovers compatible Soloe Devices${tailscale.tailnet ? ` on ${tailscale.tailnet}` : ''}.`;
    }
    return tailscale.sharing.message
      ?? tailscale.message
      ?? 'Refresh after finishing Tailscale setup.';
  }

  async function openSetup(): Promise<void> {
    const url = connections.snapshot.tailscale.sharing.setupUrl;
    if (!url) return;
    await ipc.system.openExternal(url);
  }
</script>

{#if !connections.supported}
  <div class="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
    Device connections are configured in the Soloe desktop application.
  </div>
{:else}
  <section class="flex flex-col gap-4" aria-label="Device connections">
    <div class="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
      <div class="flex min-w-0 gap-2.5">
        {#if tailscaleReady}
          <Wifi class="mt-0.5 size-4 shrink-0 text-success" />
        {:else if connections.snapshot.tailscale.sharing.state === 'conflict' || connections.snapshot.tailscale.state === 'error'}
          <CircleAlert class="mt-0.5 size-4 shrink-0 text-warning" />
        {:else}
          <WifiOff class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        {/if}
        <div class="min-w-0">
          <h3 class="m-0 text-xs font-medium">{setupTitle()}</h3>
          <p class="mt-1 mb-0 max-w-xl text-[11px] text-muted-foreground">
            {setupMessage()}
          </p>
        </div>
      </div>
      <div class="flex shrink-0 gap-2">
        {#if connections.snapshot.tailscale.sharing.setupUrl}
          <Button variant="outline" size="sm" class="gap-1.5" onclick={() => void openSetup().catch(reportError)}>
            <ExternalLink class="size-3.5" />
            {connections.snapshot.tailscale.state === 'unavailable' ? 'Install Tailscale' : 'Open approval'}
          </Button>
        {/if}
        <Button
          variant="outline"
          size="sm"
          class="gap-1.5"
          disabled={connections.refreshing}
          onclick={() => void connections.refresh().catch(reportError)}
        >
          <RefreshCw class={`size-3.5 ${connections.refreshing ? 'motion-safe:animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
    </div>

    {#if connections.snapshot.tailscale.state === 'connected'}
      <div class="flex flex-col gap-2">
        <div>
          <h3 class="m-0 text-xs font-medium">Discovered Devices</h3>
          <p class="mt-1 mb-0 text-[11px] text-muted-foreground">
            Compatible Soloe Devices are connected automatically. No URLs or per-Device switches are needed.
          </p>
        </div>
        {#each visibleMachines as machine (machine.id)}
          {@const status = machineStatus(machine)}
          <div class="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Monitor class="size-4" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span
                  class={`size-1.5 shrink-0 rounded-full ${
                    status.tone === 'online'
                      ? 'bg-success'
                      : status.tone === 'update'
                        ? 'bg-warning'
                        : 'bg-muted-foreground/40'
                  }`}
                  aria-hidden="true"
                ></span>
                <span class="truncate text-xs font-medium">{machine.name}</span>
              </div>
              <p class={`mt-0.5 mb-0 text-[10px] ${status.tone === 'update' ? 'text-warning' : 'text-muted-foreground'}`}>
                {status.label}
              </p>
            </div>
          </div>
        {:else}
          <div class="rounded-md border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground">
            No other Soloe Devices found yet. Start Soloe on another signed-in Tailscale machine, then refresh.
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
