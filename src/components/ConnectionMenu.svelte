<script lang="ts">
  import { onMount } from 'svelte';
  import { Monitor, RefreshCw, Settings2 } from '@lucide/svelte';
  import { connections } from '../stores/connections.svelte';
  import { cockpit } from '../stores/cockpit.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import {
    deviceFilterPresentation,
    devicePresentation,
    reconcileDeviceSummaries
  } from '../lib/device-presentation.js';
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
  let menuDevices = $derived(reconcileDeviceSummaries(
    cockpit.snapshot.devices,
    connections.snapshot.machines
  ));
  let filterPresentation = $derived(deviceFilterPresentation(
    menuDevices,
    cockpit.snapshot.filterDeviceIds
  ));
</script>

{#if connections.supported}
  {#if !connectionReady}
    <Button
      variant="ghost"
      size="icon-xs"
      class="ml-1 size-6 text-muted-foreground/80"
      title="Devices"
      aria-label="Devices"
      onclick={() => settings.openDialog('connections')}
    >
      <Monitor class="size-3" />
    </Button>
  {:else}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="icon-xs"
            class="ml-1 size-6 text-muted-foreground/80"
            title="Devices"
            aria-label="Devices"
          >
            <Monitor class="size-3" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" class="w-72">
        {#if filterPresentation.showAggregate}
          <DropdownMenu.Item
            class={filterPresentation.selectedDeviceId === null ? 'bg-primary/10 text-primary focus:bg-primary/15 focus:text-primary' : ''}
            onSelect={() => void focus(null)}
          >
            <Monitor />
            <span>All Devices</span>
          </DropdownMenu.Item>
        {/if}
        {#each menuDevices as device (device.deviceId)}
          {@const presentation = devicePresentation(device)}
          <DropdownMenu.Item
            class={filterPresentation.selectedDeviceId === device.deviceId ? 'bg-primary/10 text-primary focus:bg-primary/15 focus:text-primary' : ''}
            disabled={!presentation.actionable}
            onSelect={() => void focus(filterPresentation.showAggregate ? device.deviceId : null)}
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
