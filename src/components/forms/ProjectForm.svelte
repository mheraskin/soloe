<script lang="ts">
  import type { RunMode } from '@shared/types/sessions.js';
  import { projectModal } from '../../stores/project-modal.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { ipc } from '../../lib/ipc';

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
    if (!value) {
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
</script>

<label>
  Name
  <input
    type="text"
    required
    value={projectModal.draft.name}
    oninput={(e) => setField('name', (e.currentTarget as HTMLInputElement).value)}
  />
</label>

<label>
  Path
  <input
    type="text"
    readonly
    value={projectModal.draft.path}
  />
</label>

<div class="row">
  <label>
    Default run mode
    <select
      value={projectModal.draft.defaultRunMode ?? ''}
      onchange={(e) => setRunMode((e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">Inherit from settings</option>
      <option value="windows">Windows / native</option>
      <option value="wsl">WSL</option>
    </select>
  </label>
  {#if projectModal.draft.defaultRunMode === 'wsl'}
    <label>
      WSL distro
      <select
        required
        value={projectModal.draft.defaultWslDistro ?? wslOptions[0] ?? ''}
        onchange={(e) => setField('defaultWslDistro', (e.currentTarget as HTMLSelectElement).value)}
      >
        {#each wslOptions as distro (distro)}
          <option value={distro}>{distro}</option>
        {/each}
      </select>
    </label>
  {/if}
</div>

<label class="accent">
  <span>Accent color (optional)</span>
  <div class="accent-row">
    <input
      type="color"
      value={projectModal.draft.accentColor ?? '#7aa2f7'}
      oninput={(e) => setField('accentColor', (e.currentTarget as HTMLInputElement).value)}
    />
    <button type="button" class="clear" onclick={clearAccent}>Clear</button>
  </div>
</label>

<style>
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  label input[type='text'],
  label select {
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font: inherit;
  }
  label input[type='text']:focus,
  label select:focus {
    outline: none;
    border-color: var(--accent);
  }
  label input[readonly] {
    color: var(--muted);
    cursor: default;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .accent-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .accent input[type='color'] {
    background: transparent;
    border: 1px solid var(--border);
    padding: 0;
    width: 32px;
    height: 28px;
    border-radius: var(--radius-sm);
  }
  .clear {
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font: inherit;
    cursor: pointer;
  }
  .clear:hover {
    color: var(--fg);
    border-color: var(--border-strong);
  }
</style>
