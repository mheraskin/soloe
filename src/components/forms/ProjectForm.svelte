<script lang="ts">
  import type { RunMode } from '@shared/types/sessions.js';
  import { projectModal } from '../../stores/project-modal.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { ipc } from '../../lib/ipc';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import * as Select from '$lib/components/ui/select';

  let wslDistros = $state<string[]>([]);

  let wslOptions = $derived.by(() => {
    const values = [
      projectModal.draft.defaultWslDistro,
      settings.current.defaults.wslDistro,
      ...wslDistros,
      'Ubuntu'
    ].filter((value): value is string => Boolean(value?.trim()));
    return [...new Set(values)];
  });

  $effect(() => {
    if (!projectModal.open) return;
    void loadWslDistros();
  });

  $effect(() => {
    if (!projectModal.open) return;
    if (projectModal.draft.defaultRunMode === 'wsl' && !projectModal.draft.defaultWslDistro && wslOptions[0]) {
      setField('defaultWslDistro', wslOptions[0]);
    }
  });

  function setField<K extends keyof typeof projectModal.draft>(
    key: K,
    value: (typeof projectModal.draft)[K]
  ) {
    projectModal.draft = { ...projectModal.draft, [key]: value };
  }

  function setRunMode(value: string) {
    const next = { ...projectModal.draft };
    if (!value || value === '__inherit__') {
      delete next.defaultRunMode;
      delete next.defaultWslDistro;
    } else {
      next.defaultRunMode = value as RunMode;
      if (value === 'wsl' && !next.defaultWslDistro) {
        next.defaultWslDistro = wslOptions[0] ?? 'Ubuntu';
      }
      if (value !== 'wsl') delete next.defaultWslDistro;
    }
    projectModal.draft = next;
  }

  function clearAccent() {
    const next = { ...projectModal.draft };
    delete next.accentColor;
    projectModal.draft = next;
  }

  async function loadWslDistros() {
    try {
      wslDistros = await ipc.system.listWslDistros();
    } catch {
      wslDistros = [];
    }
  }

  let runModeLabel = $derived.by(() => {
    if (!projectModal.draft.defaultRunMode) return 'Inherit from settings';
    return projectModal.draft.defaultRunMode === 'wsl' ? 'WSL' : 'Windows / native';
  });
</script>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground" for="proj-name">Name</Label>
  <Input
    id="proj-name"
    type="text"
    required
    value={projectModal.draft.name}
    oninput={(e) => setField('name', (e.currentTarget as HTMLInputElement).value)}
  />
</div>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground" for="proj-path">Path</Label>
  <Input
    id="proj-path"
    type="text"
    readonly
    class="text-muted-foreground"
    value={projectModal.draft.path}
  />
</div>

<div class="grid grid-cols-2 gap-3">
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground">Default run mode</Label>
    <Select.Root
      type="single"
      value={projectModal.draft.defaultRunMode ?? '__inherit__'}
      onValueChange={setRunMode}
    >
      <Select.Trigger class="w-full">{runModeLabel}</Select.Trigger>
      <Select.Content>
        <Select.Item value="__inherit__" label="Inherit from settings">Inherit from settings</Select.Item>
        <Select.Item value="windows" label="Windows / native">Windows / native</Select.Item>
        <Select.Item value="wsl" label="WSL">WSL</Select.Item>
      </Select.Content>
    </Select.Root>
  </div>
  {#if projectModal.draft.defaultRunMode === 'wsl'}
    <div class="flex flex-col gap-1.5">
      <Label class="text-xs text-muted-foreground">WSL distro</Label>
      <Select.Root
        type="single"
        value={projectModal.draft.defaultWslDistro ?? wslOptions[0] ?? ''}
        onValueChange={(v) => setField('defaultWslDistro', v)}
      >
        <Select.Trigger class="w-full">
          {projectModal.draft.defaultWslDistro ?? wslOptions[0] ?? ''}
        </Select.Trigger>
        <Select.Content>
          {#each wslOptions as distro (distro)}
            <Select.Item value={distro} label={distro}>{distro}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}
</div>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Accent color (optional)</Label>
  <div class="flex items-center gap-2">
    <input
      class="h-7 w-8 rounded-md border border-border bg-transparent p-0"
      type="color"
      value={projectModal.draft.accentColor ?? '#7aa2f7'}
      oninput={(e) => setField('accentColor', (e.currentTarget as HTMLInputElement).value)}
    />
    <Button type="button" variant="outline" size="sm" onclick={clearAccent}>Clear</Button>
  </div>
</div>
