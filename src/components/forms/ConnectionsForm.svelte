<script lang="ts">
  import { onMount } from 'svelte';
  import { CircleAlert, ExternalLink, Globe2, Monitor, RefreshCw, Trash2, Wifi, WifiOff } from '@lucide/svelte';
  import { connections } from '../../stores/connections.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { ipc } from '../../lib/ipc';
  import {
    connectionDiscoverySummary,
    connectionDevicePresentation,
    connectionDevices,
    connectionShortUrlPresentation
  } from '../../lib/device-presentation.js';
  import { Badge } from '$lib/components/ui/badge';
  import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Switch } from '$lib/components/ui/switch';
  import type {
    ConnectionId,
    MachineConnection,
    ShortDnsInfo
  } from '@shared/types/connections.js';

  onMount(() => {
    if (!connections.loaded) void connections.load().catch(reportError);
  });

  let tailscaleReady = $derived(
    connections.snapshot.tailscale.state === 'connected'
      && connections.snapshot.tailscale.sharing.state === 'ready'
  );
  let portDraft = $state('443');
  let savingPreferences = $state(false);
  let settingUpDns = $state<ConnectionId | null>(null);
  let removingDns = $state<ConnectionId | null>(null);
  let removeDnsOpen = $state(false);
  let removeDnsTargetId = $state<ConnectionId | null>(null);
  let bridgeDeviceId = $state<string | undefined>(undefined);
  let bridgePortDraft = $state('8971');
  let openingBridge = $state(false);
  let closingBridgePort = $state<number | null>(null);

  $effect(() => {
    if (!savingPreferences) {
      portDraft = String(connections.snapshot.preferences.tailscaleHttpsPort);
    }
  });
  let visibleMachines = $derived.by(() => {
    if (connections.snapshot.tailscale.state !== 'connected') return [];
    return connectionDevices(connections.snapshot.machines);
  });
  let bridgeDevices = $derived(visibleMachines.filter(isBridgeDevice));
  let effectiveBridgeDeviceId = $derived(
    bridgeDevices.some((machine) => machine.deviceId === bridgeDeviceId)
      ? bridgeDeviceId
      : bridgeDevices[0]?.deviceId
  );
  let selectedBridgeDevice = $derived(
    bridgeDevices.find((machine) => machine.deviceId === effectiveBridgeDeviceId) ?? null
  );

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
      if (
        enabled
        && connections.shortDnsSetupSupported
        && connections.snapshot.shortDns.state === 'setup-required'
      ) {
        await setupShortDns();
      }
    } finally {
      savingPreferences = false;
    }
  }

  async function setupShortDns(targetId: ConnectionId = 'local'): Promise<void> {
    settingUpDns = targetId;
    try {
      await connections.setupShortDns(targetId);
    } finally {
      settingUpDns = null;
    }
  }

  async function openShortDnsApproval(
    shortDns: ShortDnsInfo = connections.snapshot.shortDns
  ): Promise<void> {
    const url = shortDns.setupUrl;
    if (url) await ipc.system.openExternal(url);
  }

  async function removeShortDns(targetId: ConnectionId): Promise<void> {
    removingDns = targetId;
    try {
      await connections.removeShortDns(targetId);
    } finally {
      removingDns = null;
    }
  }

  async function confirmShortDnsRemoval(): Promise<void> {
    const targetId = removeDnsTargetId;
    const shortDns = removalShortDns();
    if (!targetId || !shortDns) return;
    if (shortDns.state === 'ready') {
      await openShortDnsApproval(shortDns);
      return;
    }
    if (shortDns.state === 'route-required') {
      await removeShortDns(targetId);
    }
  }

  function requestDnsRemoval(targetId: ConnectionId): void {
    removeDnsTargetId = targetId;
    removeDnsOpen = true;
  }

  function shortDnsForMachine(machine: MachineConnection): ShortDnsInfo | null {
    return machine.id === 'local' ? connections.snapshot.shortDns : machine.shortDns ?? null;
  }

  function removalMachine(): MachineConnection | null {
    return connections.snapshot.machines.find((machine) => machine.id === removeDnsTargetId) ?? null;
  }

  function removalShortDns(): ShortDnsInfo | null {
    const machine = removalMachine();
    return machine ? shortDnsForMachine(machine) : null;
  }

  function shortDnsTitle(): string {
    const state = connections.snapshot.shortDns.state;
    if (state === 'ready') return 'Short Device URLs are ready';
    if (state === 'setup-required') return 'Set up short Device URLs';
    if (state === 'route-required') return 'Approve the private DNS route';
    if (state === 'disabled') return 'Short Device URLs are off';
    return 'Short Device URLs need attention';
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

  async function openLocalhostBridge(): Promise<void> {
    const port = Number(bridgePortDraft);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Port must be between 1 and 65535.');
    }
    if (!effectiveBridgeDeviceId) throw new Error('Choose a remote Device.');
    openingBridge = true;
    try {
      const bridge = await connections.openLocalhostBridge({
        deviceId: effectiveBridgeDeviceId,
        port
      });
      await openBridge(bridge.port);
    } finally {
      openingBridge = false;
    }
  }

  async function openBridge(port: number): Promise<void> {
    await ipc.system.openExternal(`http://127.0.0.1:${port}`);
  }

  async function closeLocalhostBridge(port: number): Promise<void> {
    closingBridgePort = port;
    try {
      await connections.closeLocalhostBridge(port);
    } finally {
      closingBridgePort = null;
    }
  }

  type BridgeDevice = MachineConnection & { deviceId: string };

  function isBridgeDevice(machine: MachineConnection): machine is BridgeDevice {
    return !machine.isSelf
      && machine.enabled
      && machine.status === 'available'
      && machine.trust === 'pinned'
      && machine.compatibility?.status === 'compatible'
      && !machine.updateRequired
      && Boolean(machine.deviceId);
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
        <span class="text-[11px] font-medium">Soloe HTTPS port</span>
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
        Keep 443 for a port-free HTTPS URL. Other devices must use the same Tailscale Serve port.
      </p>
    </div>

    {#if connections.snapshot.preferences.tailscaleEnabled}
      <div class="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
        <div class="flex min-w-0 gap-2.5">
          <Globe2 class={`mt-0.5 size-4 shrink-0 ${connections.snapshot.shortDns.state === 'ready' ? 'text-success' : 'text-muted-foreground'}`} />
          <div class="min-w-0">
            <h3 class="m-0 text-xs font-medium">{shortDnsTitle()}</h3>
            {#if connections.snapshot.shortDns.message}
              <p class="mt-1 mb-0 max-w-xl text-[11px] text-muted-foreground">
                {connections.snapshot.shortDns.message}
              </p>
            {/if}
            {#if connections.snapshot.shortDns.zone && connections.snapshot.shortDns.nameserver}
              <p class="mt-1 mb-0 font-mono text-[10px] text-muted-foreground">
                {connections.snapshot.shortDns.zone} → {connections.snapshot.shortDns.nameserver}
              </p>
            {/if}
          </div>
        </div>
        {#if connections.snapshot.shortDns.state === 'setup-required'}
          {#if connections.shortDnsSetupSupported}
            <Button
              variant="outline"
              size="sm"
              disabled={settingUpDns !== null}
              onclick={() => void setupShortDns().catch(reportError)}
            >
              {settingUpDns === 'local' ? 'Installing…' : 'Install DNS'}
            </Button>
          {/if}
        {:else if connections.snapshot.shortDns.state === 'route-required'}
          <div class="flex shrink-0 flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onclick={() => void openShortDnsApproval().catch(reportError)}>
              <ExternalLink data-icon="inline-start" />
              Open Tailscale DNS
            </Button>
            {#if connections.shortDnsRemovalSupported}
              <Button variant="outline" size="sm" onclick={() => requestDnsRemoval('local')}>
                <Trash2 data-icon="inline-start" />
                Remove DNS
              </Button>
            {/if}
          </div>
        {:else if connections.snapshot.shortDns.state === 'ready' && connections.shortDnsRemovalSupported}
          <Button variant="outline" size="sm" onclick={() => requestDnsRemoval('local')}>
            <Trash2 data-icon="inline-start" />
            Remove DNS
          </Button>
        {/if}
      </div>

      <AlertDialog.Root bind:open={removeDnsOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Remove short Device URLs?</AlertDialog.Title>
            <AlertDialog.Description>
              {#if removalShortDns()?.state === 'ready'}
                First remove the restricted nameserver for {removalShortDns()?.zone} in Tailscale DNS.
                Then return here, refresh, and choose Remove DNS again to uninstall the helper.
              {:else}
                The private DNS route is no longer active. This will uninstall the Soloe DNS helper from
                {removalMachine()?.name ?? 'this Device'}.
              {/if}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={removingDns !== null}>Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              variant={removalShortDns()?.state === 'ready' ? 'default' : 'destructive'}
              disabled={removingDns !== null}
              onclick={() => void confirmShortDnsRemoval().catch(reportError)}
            >
              {#if removalShortDns()?.state === 'ready'}
                Open Tailscale DNS
              {:else}
                {removingDns !== null ? 'Uninstalling…' : 'Uninstall DNS'}
              {/if}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    {/if}

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

    {#if connections.localhostBridgeSupported && connections.snapshot.preferences.tailscaleEnabled}
      <div class="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
        <div>
          <h3 class="m-0 text-xs font-medium">Open remote localhost here</h3>
          <p class="mt-1 mb-0 text-[11px] text-muted-foreground">
            Use the same port on this Device. No DNS setup required; the bridge stops with Soloe.
          </p>
        </div>

        <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_auto]">
          <Select.Root
            type="single"
            value={effectiveBridgeDeviceId}
            onValueChange={(value) => bridgeDeviceId = value}
          >
            <Select.Trigger class="h-8 w-full text-xs" aria-label="Remote Device">
              <span class="flex min-w-0 items-center gap-2">
                <Monitor class="size-3.5 shrink-0" />
                <span class="truncate">{selectedBridgeDevice?.name ?? 'Choose Device'}</span>
              </span>
            </Select.Trigger>
            <Select.Content class="w-(--bits-select-anchor-width)">
              {#each bridgeDevices as machine (machine.deviceId)}
                <Select.Item value={machine.deviceId} label={machine.name}>
                  <span class="flex items-center gap-2">
                    <span class="size-2 rounded-full bg-success"></span>
                    {machine.name}
                  </span>
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <Input
            class="h-8"
            type="number"
            min="1"
            max="65535"
            step="1"
            bind:value={bridgePortDraft}
            aria-label="Remote localhost port"
          />
          <Button
            size="sm"
            disabled={openingBridge || !effectiveBridgeDeviceId || !tailscaleReady}
            onclick={() => void openLocalhostBridge().catch(reportError)}
          >
            <ExternalLink data-icon="inline-start" />
            {openingBridge ? 'Opening…' : 'Open locally'}
          </Button>
        </div>

        {#if bridgeDevices.length === 0}
          <p class="m-0 text-[11px] text-muted-foreground">
            Connect another Soloe Device to use a localhost bridge.
          </p>
        {/if}

        {#if connections.localhostBridges.length > 0}
          <div class="flex flex-col gap-1.5 border-t border-border pt-2.5">
            {#each connections.localhostBridges as bridge (bridge.port)}
              <div class="flex min-w-0 items-center gap-2 rounded border border-border bg-background/60 px-2.5 py-2">
                <span class="min-w-0 flex-1 truncate font-mono text-[11px]">
                  localhost:{bridge.port}
                  <span class="text-muted-foreground">→ {bridge.deviceName}:{bridge.port}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => void openBridge(bridge.port).catch(reportError)}
                >
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={closingBridgePort === bridge.port}
                  onclick={() => void closeLocalhostBridge(bridge.port).catch(reportError)}
                >
                  {closingBridgePort === bridge.port ? 'Stopping…' : 'Stop'}
                </Button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if connections.snapshot.tailscale.state === 'connected'}
      <div class="flex flex-col gap-2">
        <h3 class="m-0 text-xs font-medium">Devices</h3>
        {#each visibleMachines as machine (machine.id)}
          {@const presentation = connectionDevicePresentation(machine)}
          {@const shortUrl = connectionShortUrlPresentation(machine, connections.snapshot.shortDns)}
          {@const deviceDns = shortDnsForMachine(machine)}
          <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md border border-border px-3 py-2.5">
            <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Monitor class="size-4" />
            </span>
            <div class="flex min-w-0 flex-col items-start gap-1.5">
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate text-xs font-medium">{presentation.name}</span>
                {#if presentation.isLocal}
                  <span class="shrink-0 text-[10px] text-muted-foreground">This device</span>
                {/if}
              </div>
              <Badge variant={shortUrl.tone === 'ready' ? 'secondary' : 'outline'}>
                {shortUrl.status}{shortUrl.zone ? ` · ${shortUrl.zone}` : ''}
              </Badge>
            </div>
            <div class="flex shrink-0 items-center justify-end gap-2">
              {#if presentation.tone === 'online' && deviceDns?.state === 'setup-required' && connections.shortDnsSetupSupported}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={settingUpDns !== null}
                  onclick={() => void setupShortDns(machine.id).catch(reportError)}
                >
                  {settingUpDns === machine.id ? 'Installing…' : 'Install DNS'}
                </Button>
              {:else if presentation.tone === 'online' && deviceDns?.state === 'route-required'}
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => void openShortDnsApproval(deviceDns).catch(reportError)}
                >
                  <ExternalLink data-icon="inline-start" />
                  Open DNS
                </Button>
                {#if connections.shortDnsRemovalSupported}
                  <Button variant="outline" size="sm" onclick={() => requestDnsRemoval(machine.id)}>
                    <Trash2 data-icon="inline-start" />
                    Remove DNS
                  </Button>
                {/if}
              {:else if presentation.tone === 'online' && deviceDns?.state === 'ready' && connections.shortDnsRemovalSupported}
                <Button variant="outline" size="sm" onclick={() => requestDnsRemoval(machine.id)}>
                  <Trash2 data-icon="inline-start" />
                  Remove DNS
                </Button>
              {/if}
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
