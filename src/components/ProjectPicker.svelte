<script lang="ts">
  import { Folder } from 'lucide-svelte';
  import type { ProjectId } from '@shared/types/projects.js';
  import { projects } from '../stores/projects.svelte';

  let {
    value,
    onchange
  }: {
    value: ProjectId | null;
    onchange: (id: ProjectId | null) => void;
  } = $props();

  function handleChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
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
    </select>
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
</style>
