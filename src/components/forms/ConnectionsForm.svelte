<script lang="ts">
  import { onMount } from 'svelte';
  import { CircleAlert, ExternalLink, Monitor, RefreshCw, Wifi, WifiOff } from '@lucide/svelte';
  import { connections } from '../../stores/connections.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { ipc } from '../../lib/ipc';
  import {
    connectionDiscoverySummary,
    connectionDevicePresentation,
    connectionDevices
  } from '../../lib/device-presentation.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
  });

  let tailscaleReady = $derived(
    connections.snapshot.tailscale.state === 'connected'
      && connections.snapshot.tailscale.sharing.state === 'ready'
  );
  let portDraft = $state('4318');
  let savingPreferences = $state(false);

  $effect(() => {
    if (!savingPreferences) {
      portDraft = String(connections.snapshot.preferences.tailscaleHttpsPort);
    }
  });
  let visibleMachines = $derived.by(() => {
    if (connections.snapshot.tailscale.state !== 'connected') return [];
    return connectionDevices(connections.snapshot.machines);
  });

  function setupTitle(): string {
    const network = connections.snapshot.tailscale.state;
    const sharing = connections.snapshot.tailscale.sharing.state;
    if (network === 'unavailable') return 'Install Tailscale to connect devices';
    if (network === 'not-running') return 'Sign in to Tailscale';
    if (sharing === 'setup-required') return 'Approve Soloe device sharing';
    if (sharing === 'conflict') return 'Tailscale port needs attention';
    if (network === 'connected' && sharing === 'ready') return 'Tailscale connected';
    return 'Tailscale connection needs attention';
  }

  function setupMessage(): string | null {
    const tailscale = connections.snapshot.tailscale;
    if (tailscale.state === 'unavailable') {
      return 'Soloe works locally without Tailscale. Install it only when you want to use Sessions on other machines.';
    }
    if (tailscale.state === 'not-running') {
      return 'Open the Tailscale app and sign in. Return here and refresh; Soloe does not need to restart.';
    }
    if (tailscale.state === 'connected' && tailscale.sharing.state === 'ready') {
      return connectionDiscoverySummary(visibleMachines);
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

  async function setTailscaleEnabled(enabled: boolean): Promise<void> {
    savingPreferences = true;
    try {
      await connections.configureTailscale({ tailscaleEnabled: enabled });
    } finally {
      savingPreferences = false;
    }
  }

  async function savePort(): Promise<void> {
    const port = Number(portDraft);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      portDraft = String(connections.snapshot.preferences.tailscaleHttpsPort);
      throw new Error('Tailscale Serve port must be between 1 and 65535.');
    }
    if (port === connections.snapshot.preferences.tailscaleHttpsPort) return;
    savingPreferences = true;
    try {
      await connections.configureTailscale({ tailscaleHttpsPort: port });
    } finally {
      savingPreferences = false;
    }
  }
</script>

{#if !connections.supported}
  <div class="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
    Device connections are configured in the Soloe desktop application.
  </div>
{:else}
  <section class="flex flex-col gap-4" aria-label="Device connections">
    <div class="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-end">
      <label class="flex min-w-0 items-center justify-between gap-3 sm:col-span-2">
        <span class="min-w-0">
          <span class="block text-xs font-medium">Use Tailscale connections</span>
          <span class="mt-0.5 block text-[11px] text-muted-foreground">
            Discover and connect to Soloe backends on this tailnet.
          </span>
        </span>
        <Switch
          checked={connections.snapshot.preferences.tailscaleEnabled}
          disabled={savingPreferences}
          onCheckedChange={(value) => void setTailscaleEnabled(value === true).catch(reportError)}
          aria-label="Use Tailscale connections"
        />
      </label>
      <label class="flex min-w-0 flex-col gap-1 sm:col-start-2">
        <span class="text-[11px] font-medium">Soloe tailnet port</span>
        <Input
          type="number"
          min="1"
          max="65535"
          step="1"
          bind:value={portDraft}
          disabled={!connections.snapshot.preferences.tailscaleEnabled || savingPreferences}
          onblur={() => void savePort().catch(reportError)}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void savePort().catch(reportError);
            }
          }}
          aria-label="Soloe tailnet port"
        />
      </label>
      <p class="m-0 text-[10px] text-muted-foreground sm:col-start-1 sm:row-start-2 sm:self-end">
        Other devices must expose Soloe on the same Tailscale Serve port. Restart their backend after changing it.
      </p>
    </div>

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
          {#if setupMessage()}
            <p class="mt-1 mb-0 max-w-xl text-[11px] text-muted-foreground">
              {setupMessage()}
            </p>
          {/if}
        </div>
      </div>
      <div class="flex shrink-0 gap-2">
        {#if connections.snapshot.preferences.tailscaleEnabled && connections.snapshot.tailscale.sharing.setupUrl}
          <Button variant="outline" size="sm" class="gap-1.5" onclick={() => void openSetup().catch(reportError)}>
            <ExternalLink class="size-3.5" />
            {connections.snapshot.tailscale.state === 'unavailable' ? 'Install Tailscale' : 'Open approval'}
          </Button>
        {/if}
        <Button
          variant="outline"
          size="sm"
          class="gap-1.5"
          disabled={connections.refreshing || !connections.snapshot.preferences.tailscaleEnabled}
          onclick={() => void connections.refresh().catch(reportError)}
        >
          <RefreshCw class={`size-3.5 ${connections.refreshing ? 'motion-safe:animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>
    </div>

    {#if connections.snapshot.tailscale.state === 'connected'}
      <div class="flex flex-col gap-2">
        <h3 class="m-0 text-xs font-medium">Devices</h3>
        {#each visibleMachines as machine (machine.id)}
          {@const presentation = connectionDevicePresentation(machine)}
          <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md border border-border px-3 py-2.5">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Monitor class="size-4" />
            </span>
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-xs font-medium">{presentation.name}</span>
              {#if presentation.isLocal}
                <span class="shrink-0 text-[10px] text-muted-foreground">This device</span>
              {/if}
            </div>
            <span
              class={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                presentation.tone === 'online'
                  ? 'border-success/25 bg-success/10 text-success'
                  : presentation.tone === 'update'
                    ? 'border-warning/25 bg-warning/10 text-warning'
                    : 'border-border bg-muted text-muted-foreground'
              }`}
            >
              <span
                class={`size-2 rounded-full ${
                  presentation.tone === 'online'
                    ? 'bg-success'
                    : presentation.tone === 'update'
                      ? 'bg-warning'
                      : 'bg-muted-foreground/50'
                }`}
                aria-hidden="true"
              ></span>
              {presentation.status}
            </span>
          </div>
        {:else}
          <div class="rounded-md border border-dashed border-border p-4 text-center text-[11px] text-muted-foreground">
            No Devices available.
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
