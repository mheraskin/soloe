<script lang="ts">
  import { Plus, ChevronDown, ChevronRight, GitBranch } from 'lucide-svelte';
  import type { Session } from '@shared/types/sessions.js';
  import type { ProjectId } from '@shared/types/projects.js';
  import { modal } from '../stores/modal.svelte';
  import { rankMulti } from '../lib/fuzzy';
  import SessionItem from './SessionItem.svelte';

  let {
    title,
    cwd,
    projectId,
    items,
    filter = ''
  }: {
    title: string;
    cwd: string;
    projectId: ProjectId | null;
    items: Session[];
    filter?: string;
  } = $props();

  let expanded = $state(true);

  let visible = $derived.by(() => {
    const q = filter.trim();
    if (!q) return items;
    return rankMulti(q, items, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });
  let hidden = $derived(filter.trim().length > 0 && visible.length === 0);

  function toggle() {
    expanded = !expanded;
  }

  function addSession(e: Event) {
    e.stopPropagation();
    modal.openNew({
      cwd,
      projectId: projectId ?? undefined
    });
  }
</script>

{#if !hidden}
  <section>
    <header>
      <button class="toggle" onclick={toggle} aria-label={`Toggle worktree ${title}`}>
        {#if expanded}
          <ChevronDown size={11} />
        {:else}
          <ChevronRight size={11} />
        {/if}
        <GitBranch size={11} />
        <span class="title" title={cwd}>{title}</span>
        <span class="count">{items.length}</span>
      </button>
      <button class="add" onclick={addSession} title="New terminal in this worktree" aria-label="New terminal in this worktree">
        <Plus size={11} />
      </button>
    </header>
    {#if expanded}
      <div class="list">
        {#each visible as session (session.id)}
          <SessionItem {session} />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 2px 2px 4px;
  }
  .toggle {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    color: var(--muted);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }
  .toggle:hover {
    background: var(--bg-elev-2);
    color: var(--fg);
  }
  .title {
    font-size: 11px;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .count {
    color: var(--muted-2);
    font-size: 10px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--bg-elev-2);
  }
  .add {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted);
    padding: 2px 6px;
    line-height: 1;
    border-radius: var(--radius-sm);
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }
  .add:hover {
    color: var(--accent);
    border-color: var(--border);
    background: var(--bg-elev-2);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-left: 14px;
  }
</style>
