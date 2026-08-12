<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, ChevronDown, Monitor, RefreshCw, Settings2 } from '@lucide/svelte';
  import type { MachineConnection } from '@shared/types/connections.js';
  import { connections } from '../stores/connections.svelte';
  import { cockpit } from '../stores/cockpit.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
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

  let focusedName = $derived.by(() => {
    const focused = cockpit.snapshot.filterDeviceIds;
    if (focused.length === 0) return 'All Devices';
    if (focused.length > 1) return `${focused.length} Devices`;
    return cockpit.device(focused[0]!)?.name ?? 'Filtered Device';
  });

  function statusLabel(machine: MachineConnection): string {
    if (machine.id === 'local') return 'This device';
    if (machine.trust === 'identity-mismatch') return 'Device identity mismatch';
    if (machine.compatibility?.status === 'client-upgrade-required') return 'Desktop upgrade required';
    if (machine.compatibility?.status === 'device-upgrade-required') return 'Device upgrade required';
    if (machine.status === 'available') return machine.endpoint ?? 'Available';
    if (machine.status === 'unavailable') return 'Unavailable';
    return machine.endpoint ?? 'Not checked yet';
  }
</script>

{#if connections.supported}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="xs"
          class="ml-1 h-5 min-w-0 max-w-[190px] justify-start gap-1 rounded-sm px-1.5 text-[11px] font-normal text-muted-foreground/80"
          title="Filter Sessions by Device"
          aria-label="Filter Sessions by Device"
        >
          <Monitor class="size-3" />
          <span class="min-w-0 truncate">{focusedName}</span>
          <ChevronDown class="size-3 opacity-60" />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="w-72">
      <DropdownMenu.Label>Session view</DropdownMenu.Label>
      <DropdownMenu.Item onSelect={() => void focus(null)}>
        <span class="flex size-4 shrink-0 items-center justify-center">
          {#if cockpit.snapshot.filterDeviceIds.length === 0}<Check class="size-3.5" />{/if}
        </span>
        <Monitor />
        <span>All Devices</span>
      </DropdownMenu.Item>
      {#each connections.snapshot.machines.filter((candidate) => candidate.enabled && candidate.deviceId) as machine (machine.id)}
        <DropdownMenu.Item
          class={cockpit.snapshot.filterDeviceIds.includes(machine.deviceId!) ? 'bg-accent text-accent-foreground' : ''}
          disabled={machine.trust === 'identity-mismatch'}
          onSelect={() => void focus(machine.deviceId!)}
        >
          <span class="flex size-4 shrink-0 items-center justify-center">
            {#if cockpit.snapshot.filterDeviceIds.includes(machine.deviceId!)}<Check class="size-3.5" />{/if}
          </span>
          <Monitor />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate">{machine.name}</span>
            <span class="truncate font-mono text-[10px] text-muted-foreground">
              {statusLabel(machine)}
            </span>
          </span>
          <span
            class={`size-1.5 shrink-0 rounded-full ${
              machine.trust === 'identity-mismatch'
                ? 'bg-destructive'
                : machine.status === 'available'
                ? 'bg-success'
                : machine.status === 'unavailable'
                  ? 'bg-destructive'
                  : 'bg-muted-foreground/50'
            }`}
            aria-hidden="true"
          ></span>
        </DropdownMenu.Item>
      {/each}
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        disabled={connections.refreshing}
        onSelect={() => void connections.refresh().catch(reportError)}
      >
        <RefreshCw class={connections.refreshing ? 'motion-safe:animate-spin' : ''} />
        <span>{connections.refreshing ? 'Discovering devices…' : 'Refresh devices'}</span>
      </DropdownMenu.Item>
      {#if showSettings}
        <DropdownMenu.Item onSelect={() => settings.openDialog('connections')}>
          <Settings2 /> <span>Connection settings…</span>
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
