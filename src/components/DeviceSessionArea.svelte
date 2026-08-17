<script lang="ts">
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import { deviceSessionStatus, deviceSessionSurface } from '../lib/device-terminal-presentation';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import DeviceTerminalViewer from './DeviceTerminalViewer.svelte';
  import EmptyState from './EmptyState.svelte';
  import SessionToolbar from './SessionToolbar.svelte';

  let {
    projection,
    onClose
  }: {
    projection: MultiDeviceSessionView;
    onClose: () => void;
  } = $props();

  let pendingOperation = $derived(deviceSessions.pendingOperation(projection.key));
  let lifecyclePending = $derived(
    pendingOperation === 'starting'
    || pendingOperation === 'stopping'
    || pendingOperation === 'restarting'
  );
  let surface = $derived(deviceSessionSurface(projection, lifecyclePending));
  let displayStatus = $derived(
    pendingOperation === 'starting' || pendingOperation === 'restarting'
      ? 'starting'
      : deviceSessionStatus(projection)
  );
</script>

{#if surface === 'terminal'}
  <DeviceTerminalViewer {projection} {onClose} />
{:else}
  <section class="flex h-full min-h-0 flex-col overflow-hidden bg-background">
    <SessionToolbar {projection} {onClose} />
    <div class="min-h-0 flex-1">
      <EmptyState
        session={projection.session}
        status={displayStatus}
        observation={projection.observation ?? null}
        onResume={() => deviceSessions.openSession(projection.key)}
        pendingAction={pendingOperation}
        showLocalOnlyActions={false}
      />
    </div>
  </section>
{/if}
