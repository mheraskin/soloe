<script lang="ts">
  import { onMount } from 'svelte';
  import { ChevronDown, Monitor, RefreshCw, Settings2 } from '@lucide/svelte';
  import type { CockpitDeviceSummary } from '@shared/types/cockpit.js';
  import { connections } from '../stores/connections.svelte';
  import { cockpit } from '../stores/cockpit.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { devicePresentation } from '../lib/device-presentation.js';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

  let { showSettings = true }: { showSettings?: boolean } = $props();

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
    if (!cockpit.loaded) void cockpit.load().catch(reportError);
  });

  async function focus(deviceId: string | null): Promise<void> {
    try {
      await cockpit.setFilter(deviceId ? [deviceId] : []);
    } catch (error) {
      reportError(error);
    }
  }

  let connectionReady = $derived(
    connections.snapshot.tailscale.state === 'connected'
      && connections.snapshot.tailscale.sharing.state === 'ready'
  );
  let focusedName = $derived.by(() => {
    const focused = cockpit.snapshot.filterDeviceIds;
    if (focused.length === 0) return 'All';
    if (focused.length > 1) return `${focused.length} devices`;
    return cockpit.device(focused[0]!)?.name ?? 'Unavailable device';
  });
  let menuDevices = $derived.by(() => {
    const devices: CockpitDeviceSummary[] = [...cockpit.snapshot.devices];
    for (const machine of connections.snapshot.machines) {
      if (
        !machine.deviceId
        || machine.source === 'manual'
        || devices.some((device) => device.deviceId === machine.deviceId)
      ) continue;
      const state: CockpitDeviceSummary['state'] = machine.updateRequired
        || (machine.compatibility && machine.compatibility.status !== 'compatible')
          ? 'incompatible'
          : machine.status === 'unavailable' || machine.trust === 'identity-mismatch'
            ? 'offline'
            : 'connecting';
      devices.push({
        deviceId: machine.deviceId,
        name: machine.name,
        state
      });
    }
    return devices;
  });
</script>

{#if connections.supported}
  {#if !connectionReady}
    <Button
      variant="ghost"
      size="xs"
      class="ml-1 h-5 min-w-0 max-w-[190px] justify-start gap-1 rounded-sm px-1.5 text-[11px] font-normal text-muted-foreground/80"
      title="Connect Soloe Sessions across your Tailscale network"
      onclick={() => settings.openDialog('connections')}
    >
      <Monitor class="size-3" />
      <span class="min-w-0 truncate">Connect devices</span>
    </Button>
  {:else}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="xs"
            class="ml-1 h-5 min-w-0 max-w-[220px] justify-start gap-1 rounded-sm px-1.5 text-[11px] font-normal text-muted-foreground/80"
            title="Choose which Sessions appear in the sidebar"
            aria-label="Filter Sessions by owning Device"
          >
            <Monitor class="size-3" />
            <span class="shrink-0 text-muted-foreground/60">Sessions from:</span>
            <span class="min-w-0 truncate">{focusedName}</span>
            <ChevronDown class="size-3 opacity-60" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" class="w-72">
        <DropdownMenu.Label>Show Sessions from</DropdownMenu.Label>
        <DropdownMenu.Item
          class={cockpit.snapshot.filterDeviceIds.length === 0 ? 'bg-primary/10 text-primary focus:bg-primary/15 focus:text-primary' : ''}
          onSelect={() => void focus(null)}
        >
          <Monitor />
          <span>All Devices</span>
        </DropdownMenu.Item>
        {#each menuDevices as device (device.deviceId)}
          {@const presentation = devicePresentation(device)}
          <DropdownMenu.Item
            class={cockpit.snapshot.filterDeviceIds.includes(device.deviceId) ? 'bg-primary/10 text-primary focus:bg-primary/15 focus:text-primary' : ''}
            disabled={!presentation.actionable}
            onSelect={() => void focus(device.deviceId)}
          >
            <span
              class={`size-1.5 shrink-0 rounded-full ${
                presentation.tone === 'online'
                  ? 'bg-success'
                  : presentation.tone === 'update'
                    ? 'bg-warning'
                    : 'bg-muted-foreground/35'
              }`}
              aria-hidden="true"
            ></span>
            <span class="min-w-0 flex-1 truncate">{presentation.label}</span>
          </DropdownMenu.Item>
        {/each}
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          disabled={connections.refreshing || cockpit.refreshing}
          onSelect={() => {
            void connections.refresh()
              .then(() => cockpit.refresh())
              .catch(reportError);
          }}
        >
          <RefreshCw class={connections.refreshing || cockpit.refreshing ? 'motion-safe:animate-spin' : ''} />
          <span>{connections.refreshing || cockpit.refreshing ? 'Finding Sessions…' : 'Refresh'}</span>
        </DropdownMenu.Item>
        {#if showSettings}
          <DropdownMenu.Item onSelect={() => settings.openDialog('connections')}>
            <Settings2 /> <span>Connection settings…</span>
          </DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/if}
