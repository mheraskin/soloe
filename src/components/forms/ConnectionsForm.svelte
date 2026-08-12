<script lang="ts">
  import { onMount } from 'svelte';
  import { Check, LoaderCircle, Monitor, RefreshCw, Trash2, Wifi, WifiOff } from '@lucide/svelte';
  import type { ConnectionId } from '@shared/types/connections.js';
  import { connections } from '../../stores/connections.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';

  let endpoint = $state('');
  let adding = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
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

  async function select(id: ConnectionId): Promise<void> {
    try {
      await connections.select(id);
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
</script>

{#if !connections.supported}
  <div class="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
    Device switching is available in the Electron desktop application.
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
        Switching relaunches this Electron window against the selected Application Server. Running
        agents stay on their device.
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
              <span class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                <Check class="size-2.5" /> Active
              </span>
            {/if}
          </div>
          <p class="mt-0.5 mb-0 truncate font-mono text-[10px] text-muted-foreground">
            {machine.id === 'local' ? 'This device' : machine.endpoint}
            {#if machine.id !== 'local'} · {machine.status}{/if}
          </p>
        </div>
        {#if !machine.active}
          <Button
            variant="outline"
            size="sm"
            disabled={machine.status === 'unavailable' || connections.switchingId !== null}
            onclick={() => void select(machine.id)}
          >
            {#if connections.switchingId === machine.id}
              <LoaderCircle class="size-3.5 motion-safe:animate-spin" />
            {:else}
              Connect
            {/if}
          </Button>
        {/if}
        {#if machine.id !== 'local' && !machine.active}
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
