<script lang="ts">
  import { Folder, FolderPlus } from 'lucide-svelte';
  import type { ProjectId } from '@shared/types/projects.js';
  import { projects } from '../stores/projects.svelte';

  let {
    value,
    onchange,
    onCreateNew
  }: {
    value: ProjectId | null;
    onchange: (id: ProjectId | null) => void;
    onCreateNew?: () => void;
  } = $props();

  function handleChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v === '__create__') {
      onCreateNew?.();
      return;
    }
    onchange(v === '' ? null : v);
  }
</script>

<label class="picker">
  Project
  <div class="row">
    <Folder size={12} />
    <select value={value ?? ''} onchange={handleChange}>
      <option value="">Unassigned</option>
      {#each projects.recents as p (p.id)}
        <option value={p.id}>{p.name}</option>
      {/each}
      {#if onCreateNew}
        <option value="__create__">+ New project…</option>
      {/if}
    </select>
    {#if onCreateNew}
      <button type="button" class="add" onclick={onCreateNew} title="New project" aria-label="New project">
        <FolderPlus size={12} />
      </button>
    {/if}
  </div>
</label>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  select {
    flex: 1;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    padding: 6px 8px;
    font: inherit;
  }
  select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .add {
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: var(--radius-sm);
    padding: 4px 6px;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }
  .add:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
