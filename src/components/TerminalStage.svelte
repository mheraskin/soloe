<script lang="ts">
  import type { SessionId } from '@shared/types/sessions.js';
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import {
    TerminalResidency,
    localTerminalPresentationKey,
    type TerminalPresentationKey
  } from '../lib/terminal-residency';
  import {
    deviceSessionSurface,
    deviceTerminalPresentationKey
  } from '../lib/device-terminal-presentation';
  import TerminalArea from './TerminalArea.svelte';
  import DeviceTerminalStage from './DeviceTerminalStage.svelte';

  interface Props {
    active?: boolean;
    interactive?: boolean;
    onOpenNavigation?: () => void;
    onClose: () => void;
  }

  let { active = true, interactive = active, onOpenNavigation, onClose }: Props = $props();

  const residency = new TerminalResidency();
  let residentKeys = $state<TerminalPresentationKey[]>([]);
  let selectedLocal = $derived(sessions.selected);
  let split = $derived(sessions.activeSplit);
  let selectedDevice = $derived(deviceSessions.selectedProjection);
  let liveLocal = $derived.by(() => Object.values(sessions.runtime).flatMap((runtime) => {
    if (!runtime.terminalId) return [];
    if (runtime.status !== 'running' && runtime.status !== 'starting') return [];
    return [{
      key: localTerminalPresentationKey(runtime.terminalId),
      sessionId: runtime.sessionId
    }];
  }));
  let liveDevice = $derived.by(() => deviceSessions.sessions.filter((projection) => (
    deviceSessionSurface(projection) === 'terminal'
    && deviceSessions.device(projection.ref.deviceId)?.local !== true
  )));
  let localSessionByKey = $derived(
    new Map<TerminalPresentationKey, SessionId>(
      liveLocal.map((entry) => [entry.key, entry.sessionId])
    )
  );
  let deviceProjectionByKey = $derived(
    new Map<TerminalPresentationKey, MultiDeviceSessionView>(
      liveDevice.map((projection) => [deviceTerminalPresentationKey(projection), projection])
    )
  );
  let presentedLocalKeys = $derived.by<TerminalPresentationKey[]>(() => {
    const sessionIds = split
      ? [split.focusedId, split.focusedId === split.leftId ? split.rightId : split.leftId]
      : selectedLocal
        ? [selectedLocal.id]
        : [];
    return sessionIds.flatMap((sessionId) => {
      const runtime = sessions.runtime[sessionId];
      return runtime?.terminalId
        && (runtime.status === 'running' || runtime.status === 'starting')
        ? [localTerminalPresentationKey(runtime.terminalId)]
        : [];
    });
  });
  let presentedKeys = $derived.by<TerminalPresentationKey[]>(() => {
    if (selectedDevice && deviceSessionSurface(selectedDevice) === 'terminal') {
      return [deviceTerminalPresentationKey(selectedDevice)];
    }
    return presentedLocalKeys;
  });
  let residentLocalSessionIds = $derived(
    residentKeys.flatMap((key) => {
      const sessionId = localSessionByKey.get(key);
      return sessionId ? [sessionId] : [];
    })
  );
  let residentDeviceKeys = $derived(
    residentKeys.filter((key) => deviceProjectionByKey.has(key))
  );

  $effect(() => {
    const next = residency.reconcile({
      livePresentationKeys: [
        ...liveLocal.map((entry) => entry.key),
        ...liveDevice.map(deviceTerminalPresentationKey)
      ],
      presentedKeys,
      maxResidents: settings.current.terminal.maxResidentPresentations
    });
    if (
      next.length !== residentKeys.length
      || next.some((key, index) => residentKeys[index] !== key)
    ) {
      residentKeys = next;
    }
  });
</script>

<div class={selectedDevice ? 'hidden' : 'contents'}>
  <TerminalArea
    residentSessionIds={residentLocalSessionIds}
    active={active && !selectedDevice}
    interactive={interactive && !selectedDevice}
    {onOpenNavigation}
  />
</div>
<DeviceTerminalStage
  projections={deviceSessions.sessions}
  selected={selectedDevice}
  residentPresentationKeys={residentDeviceKeys}
  {active}
  {interactive}
  {onClose}
/>
