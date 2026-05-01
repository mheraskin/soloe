<script lang="ts">
  import { Plus, Search, FolderPlus } from 'lucide-svelte';
  import { sessions, PROJECT_UNASSIGNED_KEY } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { modal } from '../stores/modal.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import ProjectSection from './ProjectSection.svelte';

  let query = $state('');

  let orderedProjectKeys = $derived.by<string[]>(() => {
    const present = new Set(sessions.projectIds);
    const ordered: string[] = [];
    for (const p of projects.recents) {
      if (present.has(p.id)) ordered.push(p.id);
    }
    if (present.has(PROJECT_UNASSIGNED_KEY)) ordered.push(PROJECT_UNASSIGNED_KEY);
    if (ordered.length === 0) ordered.push(PROJECT_UNASSIGNED_KEY);
    return ordered;
  });
</script>

<aside>
  <div class="head">
    <button class="new" onclick={() => modal.openNew()}>
      <Plus size={14} />
      <span>New terminal</span>
    </button>
    <button class="new project" onclick={() => projectModal.openNew()}>
      <FolderPlus size={14} />
      <span>New project</span>
    </button>
    <div class="search">
      <Search size={12} />
      <input
        type="search"
        placeholder="Filter sessions"
        bind:value={query}
        aria-label="Filter sessions"
      />
    </div>
  </div>
  <div class="groups">
    {#each orderedProjectKeys as key (key)}
      <ProjectSection
        project={key === PROJECT_UNASSIGNED_KEY ? null : projects.get(key)}
        sessions={sessions.byProject[key] ?? []}
        filter={query}
      />
    {/each}
  </div>
</aside>

<style>
  aside {
    width: 260px;
    flex-shrink: 0;
    background: var(--bg-elev-1);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .head {
    padding: 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .new {
    width: 100%;
    background: var(--bg-elev-3);
    color: var(--fg);
    border: 1px solid var(--border-strong);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .new:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .new.project {
    background: var(--bg-elev-2);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--muted);
  }
  .search:focus-within {
    border-color: var(--accent);
    color: var(--accent);
  }
  .search input {
    background: transparent;
    border: none;
    outline: none;
    color: var(--fg);
    flex: 1;
    font-size: 12px;
    padding: 2px 0;
  }
  .search input::placeholder {
    color: var(--muted-2);
  }
  .groups {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
</style>
