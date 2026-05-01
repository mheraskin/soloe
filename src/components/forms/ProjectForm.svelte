<script lang="ts">
  import type { RunMode } from '@shared/types/sessions.js';
  import { projectModal } from '../../stores/project-modal.svelte';

  function setField<K extends keyof typeof projectModal.draft>(
    key: K,
    value: (typeof projectModal.draft)[K]
  ) {
    projectModal.draft = { ...projectModal.draft, [key]: value };
  }

  function clearAccent() {
    const next = { ...projectModal.draft };
    delete next.accentColor;
    projectModal.draft = next;
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
    required
    placeholder="/home/you/project"
    value={projectModal.draft.path}
    oninput={(e) => setField('path', (e.currentTarget as HTMLInputElement).value)}
  />
</label>

<div class="row">
  <label>
    Default run mode
    <select
      value={projectModal.draft.defaultRunMode ?? ''}
      onchange={(e) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        setField('defaultRunMode', v === '' ? undefined : (v as RunMode));
      }}
    >
      <option value="">Inherit from settings</option>
      <option value="windows">Windows / native</option>
      <option value="wsl">WSL</option>
    </select>
  </label>
  {#if projectModal.draft.defaultRunMode === 'wsl'}
    <label>
      WSL distro
      <input
        type="text"
        placeholder="Ubuntu"
        value={projectModal.draft.defaultWslDistro ?? ''}
        oninput={(e) => setField('defaultWslDistro', (e.currentTarget as HTMLInputElement).value || undefined)}
      />
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
