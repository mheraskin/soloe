<script lang="ts">
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import type { TerminalPresentationKey } from '../lib/terminal-residency';
  import {
    deviceSessionSurface,
    deviceTerminalPresentationKey
  } from '../lib/device-terminal-presentation';
  import DeviceSessionArea from './DeviceSessionArea.svelte';

  let {
    projections,
    selected,
    residentPresentationKeys,
    active = true,
    interactive = active,
    onClose
  }: {
    projections: readonly MultiDeviceSessionView[];
    selected: MultiDeviceSessionView | null;
    residentPresentationKeys: readonly TerminalPresentationKey[];
    active?: boolean;
    interactive?: boolean;
    onClose: () => void;
  } = $props();

  let residents = $derived(
    projections.filter((projection) => (
      deviceSessionSurface(projection) === 'terminal'
      && residentPresentationKeys.includes(deviceTerminalPresentationKey(projection))
    ))
  );
  let selectedKey = $derived(selected ? deviceTerminalPresentationKey(selected) : null);
  let selectedIsLive = $derived(Boolean(
    selected && deviceSessionSurface(selected) === 'terminal'
  ));
</script>

<section
  class:hidden={!selected}
  class="relative h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
  aria-hidden={!selected || !active}
  inert={!selected || !active}
>
  {#each residents as projection (deviceTerminalPresentationKey(projection))}
    {@const residentActive = active && deviceTerminalPresentationKey(projection) === selectedKey}
    <div class:hidden={!residentActive} class="absolute inset-0 min-h-0 min-w-0">
      <DeviceSessionArea
        {projection}
        {onClose}
        active={residentActive}
        interactive={residentActive && interactive}
      />
    </div>
  {/each}
  {#if selected && !selectedIsLive}
    <div class="absolute inset-0 min-h-0 min-w-0">
      <DeviceSessionArea
        projection={selected}
        {onClose}
        {active}
        interactive={active && interactive}
      />
    </div>
  {/if}
</section>
