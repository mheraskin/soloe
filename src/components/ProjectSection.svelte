<script lang="ts">
  import { ChevronDown, ChevronRight, Folder, Pencil, Plus } from 'lucide-svelte';
  import type { Session } from '@shared/types/sessions.js';
  import type { Project } from '@shared/types/projects.js';
  import { modal } from '../stores/modal.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import WorktreeGroup from './WorktreeGroup.svelte';

  let {
    project,
    sessions: items,
    filter = ''
  }: { project: Project | null; sessions: Session[]; filter?: string } = $props();

  let expanded = $state(true);

  function normPath(p: string): string {
    return p.replace(/[/\\]+$/, '');
  }

  function worktreeLabel(cwd: string): string {
    if (!project) {
      const parts = normPath(cwd).split(/[/\\]/);
      return parts[parts.length - 1] || cwd;
    }
    const projectPath = normPath(project.path);
    const sessionCwd = normPath(cwd);
    if (sessionCwd === projectPath) return 'main';
    if (sessionCwd.startsWith(projectPath + '/') || sessionCwd.startsWith(projectPath + '\\')) {
      return sessionCwd.slice(projectPath.length + 1);
    }
    const parts = sessionCwd.split(/[/\\]/);
    return parts[parts.length - 1] || sessionCwd;
  }

  let worktrees = $derived.by<{ cwd: string; label: string; items: Session[] }[]>(() => {
    const order: string[] = [];
    const buckets: Record<string, Session[]> = {};
    for (const s of items) {
      const key = normPath(s.cwd);
      if (!buckets[key]) {
        buckets[key] = [];
        order.push(key);
      }
      buckets[key].push(s);
    }
    return order.map((key) => ({
      cwd: key,
      label: worktreeLabel(key),
      items: buckets[key]!
    }));
  });

  let title = $derived(project?.name ?? 'Unassigned');
  let accent = $derived(project?.accentColor ?? null);

  function toggle() {
    expanded = !expanded;
  }

  function edit(e: Event) {
    e.stopPropagation();
    if (project) projectModal.openEdit(project);
  }

  function addSession(e: Event) {
    e.stopPropagation();
    modal.openNew({
      cwd: project?.path ?? '',
      projectId: project?.id ?? undefined
    });
  }
</script>

<section>
  <header>
    <button class="toggle" onclick={toggle} aria-label={`Toggle ${title} project`}>
      {#if expanded}
        <ChevronDown size={12} />
      {:else}
        <ChevronRight size={12} />
      {/if}
      {#if accent}
        <span class="dot" style={`background: ${accent}`}></span>
      {:else}
        <Folder size={12} />
      {/if}
      <h3>{title}</h3>
      {#if project}
        <span class="path" title={project.path}>{project.path}</span>
      {/if}
    </button>
    <button class="add" onclick={addSession} title="New terminal" aria-label="New terminal">
      <Plus size={12} />
    </button>
    {#if project}
      <button class="edit" onclick={edit} title="Edit project" aria-label="Edit project">
        <Pencil size={11} />
      </button>
    {/if}
  </header>

  {#if expanded}
    <div class="worktrees">
      {#if worktrees.length === 0}
        <p class="empty">No terminals</p>
      {:else}
        {#each worktrees as wt (wt.cwd)}
          <WorktreeGroup
            title={wt.label}
            cwd={wt.cwd}
            projectId={project?.id ?? null}
            items={wt.items}
            {filter}
          />
        {/each}
      {/if}
    </div>
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 4px 2px 4px;
  }
  .toggle {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    color: var(--fg-strong);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }
  .toggle:hover {
    background: var(--bg-elev-2);
  }
  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 500;
    color: var(--fg);
    white-space: nowrap;
  }
  .path {
    color: var(--muted-2);
    font-size: 10px;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .add, .edit {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted);
    padding: 4px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .add:hover, .edit:hover {
    color: var(--accent);
    border-color: var(--border);
    background: var(--bg-elev-2);
  }
  .worktrees {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-left: 6px;
    border-left: 1px solid var(--border);
    margin-left: 10px;
  }
  .empty {
    margin: 0;
    padding: 4px 10px;
    color: var(--muted-2);
    font-size: 11px;
    font-style: italic;
  }
</style>
