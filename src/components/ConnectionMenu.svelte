<script lang="ts">
  import { onMount } from 'svelte';
  import { Monitor, RefreshCw, Settings2 } from '@lucide/svelte';
  import { connections } from '../stores/connections.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import {
    connectionDevicePresentation,
    connectionDevices
  } from '../lib/device-presentation.js';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

  let { showSettings = true }: { showSettings?: boolean } = $props();

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
    if (!deviceSessions.loaded) void deviceSessions.load().catch(reportError);
  });

  let visibleMachines = $derived(connectionDevices(connections.snapshot.machines));
  let localMachine = $derived(visibleMachines.find((machine) => machine.isSelf) ?? null);

  function dotClass(tone: 'online' | 'offline' | 'update'): string {
    if (tone === 'online') return 'bg-success';
    if (tone === 'update') return 'bg-warning';
    return 'bg-muted-foreground/35';
  }

  async function refresh(): Promise<void> {
    await connections.refresh();
    await deviceSessions.refresh();
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
          class="ml-1 min-w-0 max-w-64 gap-1.5 px-2 text-muted-foreground/80"
          title={localMachine?.name ?? 'This device'}
          aria-label={'Devices: ' + (localMachine?.name ?? 'This device')}
        >
          <Monitor class="size-3" />
          <span class="truncate">{localMachine?.name ?? 'This device'}</span>
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="w-80">
      <DropdownMenu.Label>Devices</DropdownMenu.Label>
      {#each visibleMachines as machine (machine.id)}
        {@const presentation = connectionDevicePresentation(machine)}
        <div
          class={'flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm '
            + (presentation.isLocal ? 'bg-primary/10 text-primary ' : '')
            + (presentation.tone !== 'online' && !presentation.isLocal ? 'opacity-60' : '')}
          role="status"
        >
          <span class={'size-2 shrink-0 rounded-full ' + dotClass(presentation.tone)} aria-hidden="true"></span>
          <span class="min-w-0 flex-1 truncate">{presentation.name}</span>
          <span class="shrink-0 text-xs text-muted-foreground">
            {presentation.isLocal ? 'This device' : presentation.status}
          </span>
        </div>
      {:else}
        <div class="px-2 py-2 text-sm text-muted-foreground">Loading this device…</div>
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
