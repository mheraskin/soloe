<script lang="ts">
  import { ChevronDown, ChevronRight, Folder, Pencil, Plus, Trash2 } from '@lucide/svelte';
  import type { GitWorktree } from '@shared/types/git.js';
  import type { Session } from '@shared/types/sessions.js';
  import type { Project } from '@shared/types/projects.js';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { confirmStore } from '../stores/confirm.svelte';
  import { ipc } from '../lib/ipc';
  import { Button } from '$lib/components/ui/button';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import WorktreeGroup from './WorktreeGroup.svelte';

  let {
    project,
    sessions: items,
    filter = ''
  }: { project: Project; sessions: Session[]; filter?: string } = $props();

  let expanded = $state(true);
  let gitWorktrees = $state<GitWorktree[]>([]);

  function normPath(p: string): string {
    return p.replace(/[/\\]+$/, '');
  }

  function worktreeLabel(cwd: string): string {
    const projectPath = normPath(project.path);
    const sessionCwd = normPath(cwd);
    if (sessionCwd === projectPath) return 'main';
    if (sessionCwd.startsWith(projectPath + '/') || sessionCwd.startsWith(projectPath + '\\')) {
      return sessionCwd.slice(projectPath.length + 1);
    }
    const parts = sessionCwd.split(/[/\\]/);
    return parts[parts.length - 1] || sessionCwd;
  }

  $effect(() => {
    ipc.git.worktrees({ repoPath: project.path })
      .then((worktrees) => {
        gitWorktrees = worktrees;
      })
      .catch(() => {
        gitWorktrees = [];
      });
  });

  let worktrees = $derived.by<{ cwd: string; label: string; isMain: boolean; items: Session[] }[]>(() => {
    const order: string[] = [];
    const buckets: Record<string, Session[]> = {};
    for (const worktree of gitWorktrees) {
      const key = normPath(worktree.path);
      if (!buckets[key]) {
        buckets[key] = [];
        order.push(key);
      }
    }
    for (const s of items) {
      const key = normPath(s.cwd);
      if (!buckets[key]) {
        buckets[key] = [];
        order.push(key);
      }
      buckets[key].push(s);
    }
    return order.map((key) => {
      const gitWorktree = gitWorktrees.find((wt) => normPath(wt.path) === key);
      return {
        cwd: key,
        label: gitWorktree?.branch ?? (gitWorktree?.detached ? 'detached' : worktreeLabel(key)),
        isMain: gitWorktree?.isMain ?? false,
        items: buckets[key]!
      };
    });
  });

  let accent = $derived(project.accentColor ?? null);

  function edit(e: Event) {
    e.stopPropagation();
    projectModal.openEdit(project);
  }

  function addSession(e: Event) {
    e.stopPropagation();
    void sessions
      .createWithDefaults({ projectId: project.id, cwd: project.path })
      .catch(reportError);
  }

  async function removeProject(e: Event) {
    e.stopPropagation();
    const ok = await confirmStore.ask({
      title: 'Delete project',
      message: `Delete project "${project.name}" and its ${items.length} session${items.length === 1 ? '' : 's'} from Soloe? Files on disk will not be touched.`,
      confirmLabel: 'Delete',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      for (const session of items) {
        await sessions.remove(session.id);
      }
      await projects.remove(project.id);
    } catch (err) {
      reportError(err);
    }
  }
</script>

<Collapsible.Root bind:open={expanded} class="flex flex-col gap-1">
  <div class="flex items-center gap-px px-1 pt-1 pb-0.5">
    <Collapsible.Trigger
      class="group flex flex-1 items-center gap-1.5 overflow-hidden rounded-md border border-transparent px-1.5 py-1 text-left text-foreground hover:bg-muted"
      aria-label={`Toggle ${project.name} project`}
    >
      {#if expanded}
        <ChevronDown class="size-3 shrink-0 text-muted-foreground" />
      {:else}
        <ChevronRight class="size-3 shrink-0 text-muted-foreground" />
      {/if}
      {#if accent}
        <span class="size-2.5 shrink-0 rounded-full" style={`background: ${accent}`}></span>
      {:else}
        <Folder class="size-3 shrink-0 text-muted-foreground" />
      {/if}
      <span class="truncate text-xs font-medium">{project.name}</span>
      <span class="truncate font-mono text-[10px] text-muted-foreground" title={project.path}>
        {project.path}
      </span>
    </Collapsible.Trigger>
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={addSession}
      title="New terminal"
      aria-label="New terminal"
    >
      <Plus />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={edit}
      title="Edit project"
      aria-label="Edit project"
    >
      <Pencil />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      onclick={removeProject}
      title="Delete project"
      aria-label={`Delete ${project.name}`}
    >
      <Trash2 />
    </Button>
  </div>

  <Collapsible.Content class="ml-2.5 flex flex-col gap-1 border-l border-border pl-1.5">
    {#if worktrees.length === 0}
      <p class="m-0 px-2.5 py-1 text-[11px] text-muted-foreground italic">No terminals</p>
    {:else}
      {#each worktrees as wt (wt.cwd)}
        <WorktreeGroup
          title={wt.label}
          cwd={wt.cwd}
          projectId={project.id}
          items={wt.items}
          isMain={wt.isMain}
          {filter}
        />
      {/each}
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
