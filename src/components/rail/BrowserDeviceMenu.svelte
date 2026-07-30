<script lang="ts">
  import { untrack } from 'svelte';
  import { Smartphone, Tablet, Monitor, RotateCw, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Separator } from '$lib/components/ui/separator';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { BROWSER_DEVICE_PRESETS, type BrowserDevicePreset } from '../../lib/browser-devices';
  import type { BrowserTabDevice } from '../../stores/browser.svelte';

  interface Props {
    device: BrowserTabDevice | undefined;
    onSelect: (device: BrowserTabDevice | null) => void;
    onRotate: () => void;
    onClose: () => void;
  }

  let { device, onSelect, onRotate, onClose }: Props = $props();

  // Seed the custom-size form from the current device only at mount; the
  // popover is freshly created each open so this snapshot is the right
  // behavior — we don't want later device changes to clobber what the user
  // is typing.
  let customWidth = $state(untrack(() => (device?.presetId === 'custom' ? String(device.width) : '375')));
  let customHeight = $state(untrack(() => (device?.presetId === 'custom' ? String(device.height) : '667')));
  let customDpr = $state(untrack(() => (device?.presetId === 'custom' ? String(device.dpr) : '2')));
  let customMobile = $state(untrack(() => (device?.presetId === 'custom' ? device.mobile : true)));

  function iconFor(kind: BrowserDevicePreset['kind']) {
    if (kind === 'mobile') return Smartphone;
    if (kind === 'tablet') return Tablet;
    return Monitor;
  }

  function pickPreset(preset: BrowserDevicePreset) {
    onSelect({
      presetId: preset.id,
      width: preset.width,
      height: preset.height,
      dpr: preset.dpr,
      mobile: preset.mobile,
      ua: preset.ua,
      rotated: false
    });
    onClose();
  }

  function applyCustom(event: SubmitEvent) {
    event.preventDefault();
    const w = Number(customWidth);
    const h = Number(customHeight);
    const dpr = Number(customDpr);
    if (!Number.isFinite(w) || w <= 0) return;
    if (!Number.isFinite(h) || h <= 0) return;
    if (!Number.isFinite(dpr) || dpr <= 0) return;
    onSelect({
      presetId: 'custom',
      width: Math.round(w),
      height: Math.round(h),
      dpr,
      mobile: customMobile,
      ua: '',
      rotated: false
    });
    onClose();
  }

  function clearDevice() {
    onSelect(null);
    onClose();
  }
</script>

<div class="mobile-device-menu flex max-h-[480px] w-[300px] flex-col">
  <div class="flex items-center gap-2 border-b border-border px-3 py-2">
    <Smartphone class="size-4 text-muted-foreground" />
    <span class="text-xs font-medium">Responsive viewer</span>
    {#if device}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        class="ml-auto size-6"
        aria-label="Rotate"
        title="Rotate"
        onclick={() => onRotate()}
      >
        <RotateCw class="size-3" />
      </Button>
    {/if}
  </div>

  <ScrollArea class="min-h-0 flex-1">
    <div class="flex flex-col gap-3 p-2">
      <button
        type="button"
        class={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent ${
          !device ? 'bg-accent text-accent-foreground' : ''
        }`}
        onclick={clearDevice}
      >
        <X class="size-3.5 text-muted-foreground" />
        <span class="flex-1">Off (native)</span>
      </button>

      <Separator />

      <div class="flex flex-col gap-0.5">
        <div class="px-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Devices
        </div>
        {#each BROWSER_DEVICE_PRESETS as preset (preset.id)}
          {@const Icon = iconFor(preset.kind)}
          {@const isActive = device?.presetId === preset.id}
          <button
            type="button"
            class={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-accent ${
              isActive ? 'bg-accent text-accent-foreground' : ''
            }`}
            onclick={() => pickPreset(preset)}
          >
            <Icon class="size-3.5 text-muted-foreground" />
            <span class="flex-1 truncate">{preset.label}</span>
            <span class="font-mono text-[10px] text-muted-foreground">
              {preset.width}×{preset.height}
            </span>
          </button>
        {/each}
      </div>

      <Separator />

      <form class="flex flex-col gap-2 px-1" onsubmit={applyCustom}>
        <div class="px-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Custom size
        </div>
        <div class="mobile-form-grid grid grid-cols-2 gap-2">
          <div class="flex flex-col gap-1">
            <Label class="text-[10px]" for="device-width">Width</Label>
            <Input
              id="device-width"
              bind:value={customWidth}
              inputmode="numeric"
              class="h-7 text-[11px]"
              spellcheck={false}
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-[10px]" for="device-height">Height</Label>
            <Input
              id="device-height"
              bind:value={customHeight}
              inputmode="numeric"
              class="h-7 text-[11px]"
              spellcheck={false}
            />
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <Label class="text-[10px]" for="device-dpr">Device pixel ratio</Label>
          <Input
            id="device-dpr"
            bind:value={customDpr}
            inputmode="decimal"
            class="h-7 text-[11px]"
            spellcheck={false}
          />
        </div>
        <label class="flex items-center gap-2 text-[11px]">
          <Checkbox bind:checked={customMobile} />
          <span>Touch + mobile UA</span>
        </label>
        <Button type="submit" variant="default" size="xs" class="h-7">Apply custom</Button>
      </form>
    </div>
  </ScrollArea>
</div>
