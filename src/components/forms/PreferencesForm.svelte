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

<section>
  <h3>Appearance</h3>
  <label>
    Theme
    <select
      value={settings.current.appearance.theme}
      onchange={(e) => setAppearance('theme', (e.currentTarget as HTMLSelectElement).value as ThemePref)}
    >
      {#each themes as t (t)}
        <option value={t}>{t}</option>
      {/each}
    </select>
  </label>
  <label>
    Density
    <select
      value={settings.current.appearance.density}
      onchange={(e) => setAppearance('density', (e.currentTarget as HTMLSelectElement).value as DensityPref)}
    >
      {#each densities as d (d)}
        <option value={d}>{d}</option>
      {/each}
    </select>
  </label>
  <label>
    Font size
    <select
      value={settings.current.appearance.fontSize}
      onchange={(e) => setAppearance('fontSize', Number((e.currentTarget as HTMLSelectElement).value) as FontSizePref)}
    >
      {#each fontSizes as f (f)}
        <option value={f}>{f}px</option>
      {/each}
    </select>
  </label>
</section>

<section>
  <h3>Defaults</h3>
  <label>
    Run mode
    <select
      value={settings.current.defaults.runMode}
      onchange={(e) => setDefault('runMode', (e.currentTarget as HTMLSelectElement).value)}
    >
      {#each runModes as r (r)}
        <option value={r}>{r}</option>
      {/each}
    </select>
  </label>
  <label>
    WSL distro
    <input
      type="text"
      placeholder="Ubuntu"
      value={settings.current.defaults.wslDistro ?? ''}
      onchange={(e) => setDefault('wslDistro', (e.currentTarget as HTMLInputElement).value)}
    />
  </label>
  <label>
    Shell
    <select
      value={settings.current.defaults.shell}
      onchange={(e) => setDefault('shell', (e.currentTarget as HTMLSelectElement).value)}
    >
      {#each shells as s (s)}
        <option value={s}>{s}</option>
      {/each}
    </select>
  </label>
  <label>
    Default working directory
    <input
      type="text"
      placeholder="~"
      value={settings.current.defaults.cwd}
      onchange={(e) => setDefaultCwd((e.currentTarget as HTMLInputElement).value)}
    />
  </label>
</section>

<section>
  <h3>Binaries</h3>
  <p class="hint">Leave blank to use the binary on PATH.</p>
  {#each binaryKeys as b (b.key)}
    <label>
      {b.label}
      <input
        type="text"
        placeholder={b.placeholder}
        value={settings.current.binaries[b.key] ?? ''}
        onchange={(e) => setBinary(b.key, (e.currentTarget as HTMLInputElement).value)}
      />
    </label>
  {/each}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }
  section:last-child {
    border-bottom: none;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    font-weight: 500;
  }
  .hint {
    margin: -4px 0 0;
    color: var(--muted-2);
    font-size: 11px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
</style>
