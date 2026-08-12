<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, ChevronDown, LoaderCircle, Monitor, RefreshCw, Settings2 } from '@lucide/svelte';
  import type { ConnectionId, MachineConnection } from '@shared/types/connections.js';
  import { connections } from '../stores/connections.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

  let { showSettings = true }: { showSettings?: boolean } = $props();

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
  });

  async function select(id: ConnectionId): Promise<void> {
    try {
      await connections.select(id);
    } catch (error) {
      reportError(error);
    }
  }

  function statusLabel(machine: MachineConnection): string {
    if (machine.id === 'local') return 'This device';
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
          title={connections.active?.endpoint ?? 'Soloe device'}
          aria-label="Choose Soloe device"
          disabled={connections.switchingId !== null}
        >
          {#if connections.switchingId}
            <LoaderCircle class="size-3 motion-safe:animate-spin" />
            <span>Switching…</span>
          {:else}
            <Monitor class="size-3" />
            <span class="min-w-0 truncate">{connections.active?.name ?? 'This device'}</span>
            <ChevronDown class="size-3 opacity-60" />
          {/if}
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="w-72">
      <DropdownMenu.Label>Soloe device</DropdownMenu.Label>
      {#each connections.snapshot.machines as machine (machine.id)}
        <DropdownMenu.Item
          class={machine.active ? 'bg-accent text-accent-foreground' : ''}
          disabled={machine.status === 'unavailable' || connections.switchingId !== null}
          onSelect={() => void select(machine.id)}
        >
          <span class="flex size-4 shrink-0 items-center justify-center">
            {#if machine.active}<Check class="size-3.5" />{/if}
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
              machine.status === 'available'
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
