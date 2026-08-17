<script lang="ts">
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { QuickLaunchPreset } from '@shared/types/settings.js';
  import { launchProvider } from '@shared/types/sessions.js';
  import { deviceSessionStatus, deviceSessionSurface } from '../lib/device-terminal-presentation';
  import { continuationPrompt } from '../lib/session-continuation';
  import { quickLaunchExtraArgs } from '../lib/quick-launch';
  import { defaultDraft, kindLabel } from '../lib/sessions-helpers';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { settings } from '../stores/settings.svelte';
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

  async function openNew(): Promise<void> {
    const provider = launchProvider(projection.session);
    const kind = provider ?? 'terminal';
    await deviceSessions.createBeside(projection.key, {
      name: kindLabel(kind),
      launch: defaultDraft(kind, settings.current.defaults).launch
    });
  }

  async function continueWith(provider: AgentRuntimeProvider): Promise<void> {
    await deviceSessions.createBeside(projection.key, {
      name: kindLabel(provider),
      launch: defaultDraft(provider, settings.current.defaults).launch,
      continuationPrompt: continuationPrompt(
        projection.session,
        projection.observation ?? null
      ),
      continuationProvider: provider
    });
  }

  async function launchPreset(preset: QuickLaunchPreset): Promise<void> {
    const launch = defaultDraft(preset.provider, settings.current.defaults).launch;
    if (launch.type !== 'agent') return;
    const extraArgs = quickLaunchExtraArgs(preset);
    await deviceSessions.createBeside(projection.key, {
      name: preset.label,
      launch: {
        ...launch,
        ...(preset.model ? { model: preset.model } : {}),
        ...(extraArgs.length > 0 ? { extraArgs } : {})
      }
    });
  }
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
        onOpenNew={openNew}
        onContinueWith={continueWith}
        onLaunchPreset={launchPreset}
        pendingAction={pendingOperation}
        useLocalActionFallbacks={false}
      />
    </div>
  </section>
{/if}
