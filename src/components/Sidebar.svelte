<script lang="ts">
  import { Plus, Search, FolderOpen } from 'lucide-svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { rankMulti } from '../lib/fuzzy';
  import ProjectSection from './ProjectSection.svelte';
  import SessionItem from './SessionItem.svelte';

  let query = $state('');

  let orderedProjectIds = $derived.by<string[]>(() => {
    const present = new Set(sessions.projectIds);
    const ordered: string[] = [];
    for (const p of projects.recents) {
      if (present.has(p.id)) ordered.push(p.id);
    }
    for (const id of sessions.projectIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  });

  let standaloneVisible = $derived.by(() => {
    const list = sessions.standalone;
    const q = query.trim();
    if (!q) return list;
    return rankMulti(q, list, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });
</script>

<aside>
  <div class="head">
    <button
      class="new"
      onclick={() => void sessions.createWithDefaults({}).catch(reportError)}
    >
      <Plus size={14} />
      <span>New terminal</span>
    </button>
    <button class="new project" onclick={() => commandPalette.open('open-project')}>
      <FolderOpen size={14} />
      <span>Open project</span>
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
    {#if standaloneVisible.length > 0}
      <div class="standalone">
        {#each standaloneVisible as session (session.id)}
          <SessionItem {session} />
        {/each}
      </div>
    {/if}
    {#each orderedProjectIds as id (id)}
      {@const project = projects.get(id)}
      {#if project}
        <ProjectSection
          {project}
          sessions={sessions.byProject[id] ?? []}
          filter={query}
        />
      {/if}
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
  .standalone {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
</style>
