<script lang="ts">
  import { settings } from '../../stores/settings.svelte';
  import type {
    DensityPref,
    FontSizePref,
    SettingsBinaries,
    ThemePref
  } from '@shared/types/settings.js';
  import type { RunMode, ShellKind } from '@shared/types/sessions.js';
  import { reportError } from '../../stores/toast.svelte';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import * as Select from '$lib/components/ui/select';

  const themes: ThemePref[] = ['dark', 'light', 'system'];
  const densities: DensityPref[] = ['comfortable', 'compact'];
  const fontSizes: FontSizePref[] = [11, 12, 13, 14];
  const runModes: RunMode[] = ['windows', 'wsl'];
  const shells: ShellKind[] = ['auto', 'bash', 'zsh', 'pwsh', 'cmd', 'custom'];
  const binaryKeys: { key: keyof SettingsBinaries; label: string; placeholder: string }[] = [
    { key: 'claude', label: 'Claude binary', placeholder: 'claude' },
    { key: 'codex', label: 'Codex binary', placeholder: 'codex' },
    { key: 'git', label: 'git', placeholder: 'git' },
    { key: 'gh', label: 'gh', placeholder: 'gh' },
    { key: 'fd', label: 'fd', placeholder: 'fd' },
    { key: 'rg', label: 'rg', placeholder: 'rg' },
    { key: 'editor', label: 'External editor', placeholder: 'code' }
  ];

  async function setAppearance<K extends 'theme' | 'density' | 'fontSize'>(
    key: K,
    value: ThemePref | DensityPref | FontSizePref
  ) {
    try {
      await settings.update({ appearance: { [key]: value } as never });
    } catch (e) { reportError(e); }
  }

  async function setDefault<K extends 'runMode' | 'wslDistro' | 'shell'>(
    key: K,
    value: string
  ) {
    try {
      await settings.update({ defaults: { [key]: value || undefined } as never });
    } catch (e) { reportError(e); }
  }

  async function setDefaultCwd(value: string) {
    try {
      await settings.update({ defaults: { cwd: value.trim() || '~' } });
    } catch (e) { reportError(e); }
  }

  async function setBinary(key: keyof SettingsBinaries, value: string) {
    try {
      await settings.update({ binaries: { [key]: value } as never });
    } catch (e) { reportError(e); }
  }
</script>

<section class="flex flex-col gap-2.5 border-b border-border py-3">
  <h3 class="m-0 mb-1 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">Appearance</h3>
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground">Theme</Label>
    <Select.Root
      type="single"
      value={settings.current.appearance.theme}
      onValueChange={(v) => setAppearance('theme', v as ThemePref)}
    >
      <Select.Trigger class="w-full">{settings.current.appearance.theme}</Select.Trigger>
      <Select.Content>
        {#each themes as t (t)}
          <Select.Item value={t} label={t}>{t}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground">Density</Label>
    <Select.Root
      type="single"
      value={settings.current.appearance.density}
      onValueChange={(v) => setAppearance('density', v as DensityPref)}
    >
      <Select.Trigger class="w-full">{settings.current.appearance.density}</Select.Trigger>
      <Select.Content>
        {#each densities as d (d)}
          <Select.Item value={d} label={d}>{d}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground">Font size</Label>
    <Select.Root
      type="single"
      value={String(settings.current.appearance.fontSize)}
      onValueChange={(v) => setAppearance('fontSize', Number(v) as FontSizePref)}
    >
      <Select.Trigger class="w-full">{settings.current.appearance.fontSize}px</Select.Trigger>
      <Select.Content>
        {#each fontSizes as f (f)}
          <Select.Item value={String(f)} label={`${f}px`}>{f}px</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
</section>

<section class="flex flex-col gap-2.5 border-b border-border py-3">
  <h3 class="m-0 mb-1 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">Defaults</h3>
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground">Run mode</Label>
    <Select.Root
      type="single"
      value={settings.current.defaults.runMode}
      onValueChange={(v) => setDefault('runMode', v)}
    >
      <Select.Trigger class="w-full">{settings.current.defaults.runMode}</Select.Trigger>
      <Select.Content>
        {#each runModes as r (r)}
          <Select.Item value={r} label={r}>{r}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="pref-wsl-distro">WSL distro</Label>
    <Input
      id="pref-wsl-distro"
      type="text"
      placeholder="Ubuntu"
      value={settings.current.defaults.wslDistro ?? ''}
      onchange={(e) => setDefault('wslDistro', (e.currentTarget as HTMLInputElement).value)}
    />
  </div>
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground">Shell</Label>
    <Select.Root
      type="single"
      value={settings.current.defaults.shell}
      onValueChange={(v) => setDefault('shell', v)}
    >
      <Select.Trigger class="w-full">{settings.current.defaults.shell}</Select.Trigger>
      <Select.Content>
        {#each shells as s (s)}
          <Select.Item value={s} label={s}>{s}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="pref-default-cwd">Default working directory</Label>
    <Input
      id="pref-default-cwd"
      type="text"
      placeholder="~"
      value={settings.current.defaults.cwd}
      onchange={(e) => setDefaultCwd((e.currentTarget as HTMLInputElement).value)}
    />
  </div>
</section>

<section class="flex flex-col gap-2.5 py-3">
  <h3 class="m-0 mb-1 text-[11px] font-medium tracking-widest text-muted-foreground uppercase">Binaries</h3>
  <p class="m-0 text-[11px] text-muted-foreground">Leave blank to use the binary on PATH.</p>
  {#each binaryKeys as b (b.key)}
    <div class="flex flex-col gap-1.5">
      <Label class="text-xs text-muted-foreground" for={`bin-${b.key}`}>{b.label}</Label>
      <Input
        id={`bin-${b.key}`}
        type="text"
        placeholder={b.placeholder}
        value={settings.current.binaries[b.key] ?? ''}
        onchange={(e) => setBinary(b.key, (e.currentTarget as HTMLInputElement).value)}
      />
    </div>
  {/each}
</section>
