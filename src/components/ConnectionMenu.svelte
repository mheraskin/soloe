<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, Monitor, RefreshCw, Settings2 } from '@lucide/svelte';
  import { connections } from '../stores/connections.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

  let { showSettings = true }: { showSettings?: boolean } = $props();

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
    if (!deviceSessions.loaded) void deviceSessions.load().catch(reportError);
  });

  let devices = $derived(deviceSessions.state.devices);
  let selectedDevice = $derived(
    deviceSessions.selectedDeviceId
      ? devices.find((device) => device.deviceId === deviceSessions.selectedDeviceId) ?? null
      : null
  );
  let triggerLabel = $derived(
    selectedDevice?.name ?? (devices.length > 1 ? 'All devices' : devices[0]?.name ?? 'This device')
  );

  function dotClass(available: boolean): string {
    return available ? 'bg-success' : 'bg-muted-foreground/35';
  }

  async function refresh(): Promise<void> {
    await connections.refresh();
    await deviceSessions.refresh();
  }
</script>

{#if deviceSessions.supported}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="xs"
          class="ml-1 min-w-0 max-w-64 gap-1.5 px-2 text-muted-foreground/80"
          title={'Show devices: ' + triggerLabel}
          aria-label={'Show devices: ' + triggerLabel}
        >
          <Monitor class="size-3" />
          <span class="truncate">{triggerLabel}</span>
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="w-80">
      <DropdownMenu.Label>Devices</DropdownMenu.Label>
      {#if devices.length > 1}
        <DropdownMenu.Item onSelect={() => deviceSessions.setDeviceFilter(null)}>
          <Monitor />
          <span class="min-w-0 flex-1 truncate">All devices</span>
          {#if deviceSessions.selectedDeviceId === null}<Check class="size-4" />{/if}
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
      {/if}
      {#each devices as device (device.deviceId)}
        <DropdownMenu.Item
          class={!device.available ? 'opacity-60' : undefined}
          onSelect={() => deviceSessions.setDeviceFilter(device.deviceId)}
        >
          <span class={'size-2 shrink-0 rounded-full ' + dotClass(device.available)} aria-hidden="true"></span>
          <span class="min-w-0 flex-1 truncate">{device.name}</span>
          <span class="shrink-0 text-xs text-muted-foreground">
            {device.local ? 'This device' : device.state}
          </span>
          {#if deviceSessions.selectedDeviceId === device.deviceId}<Check class="size-4" />{/if}
        </DropdownMenu.Item>
      {:else}
        <div class="px-2 py-2 text-sm text-muted-foreground">Loading devices…</div>
      {/each}
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        disabled={connections.refreshing || deviceSessions.refreshing}
        onSelect={() => void refresh().catch(reportError)}
      >
        <RefreshCw class={connections.refreshing || deviceSessions.refreshing ? 'motion-safe:animate-spin' : ''} />
        <span>{connections.refreshing || deviceSessions.refreshing ? 'Refreshing…' : 'Refresh'}</span>
      </DropdownMenu.Item>
      {#if showSettings}
        <DropdownMenu.Item onSelect={() => settings.openDialog('connections')}>
          <Settings2 /> <span>Connection settings…</span>
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
