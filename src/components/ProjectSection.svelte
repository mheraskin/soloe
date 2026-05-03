<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    ChevronDown,
    ChevronRight,
    Folder,
    FolderTree,
    Pencil,
    Trash2
  } from '@lucide/svelte';
  import { Badge } from '$lib/components/ui/badge';
  import type { GitWorktree } from '@shared/types/git.js';
  import type { Session } from '@shared/types/sessions.js';
  import type { Project } from '@shared/types/projects.js';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { nav } from '../stores/nav.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { confirmStore } from '../stores/confirm.svelte';
  import { ipc } from '../lib/ipc';
  import { rankMulti, score } from '../lib/fuzzy';
  import { cn } from '$lib/utils';
  import { Button } from '$lib/components/ui/button';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import KbdHint from './KbdHint.svelte';
  import SessionItem from './SessionItem.svelte';
  import WorktreeGroup from './WorktreeGroup.svelte';
  import AgentLaunchPopover from './AgentLaunchPopover.svelte';

  let {
    project,
    sessions: items,
    filter = ''
  }: { project: Project; sessions: Session[]; filter?: string } = $props();

  let expanded = $state(true);
  let gitWorktrees = $state<GitWorktree[]>([]);
  let loadingWorktrees = $state(false);
  let worktreeLoadFailed = $state(false);

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

  function basename(p: string): string {
    const parts = normPath(p).split(/[/\\]/);
    return parts[parts.length - 1] || p;
  }

  function gitWorktreeLabel(worktree: GitWorktree): string {
    return worktree.branch ?? (worktree.detached ? 'detached' : worktreeLabel(worktree.path));
  }

  $effect(() => {
    let cancelled = false;
    loadingWorktrees = true;
    worktreeLoadFailed = false;
    ipc.git.worktrees({
      repoPath: project.path,
      force: true,
      ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
      ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
    })
      .then((worktrees) => {
        if (cancelled) return;
        gitWorktrees = worktrees;
      })
      .catch(() => {
        if (cancelled) return;
        gitWorktrees = [];
        worktreeLoadFailed = true;
      })
      .finally(() => {
        if (!cancelled) loadingWorktrees = false;
      });
    return () => {
      cancelled = true;
    };
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
        label: gitWorktree ? gitWorktreeLabel(gitWorktree) : worktreeLabel(key),
        isMain: gitWorktree?.isMain ?? false,
        items: buckets[key]!
      };
    });
  });

  let accent = $derived(project.accentColor ?? null);
  let mainWorktree = $derived(gitWorktrees.find((wt) => wt.isMain) ?? null);
  let hasWorktrees = $derived(gitWorktrees.some((wt) => !wt.isMain));
  let isStandaloneWorktreeProject = $derived(
    hasWorktrees
      && mainWorktree !== null
      && normPath(mainWorktree.path) !== normPath(project.path)
  );
  let showWorktreeGroups = $derived(hasWorktrees && !isStandaloneWorktreeProject);
  let repoName = $derived(mainWorktree ? basename(mainWorktree.path) : project.name);
  let otherWorktreeLabels = $derived.by(() =>
    gitWorktrees
      .filter((wt) => normPath(wt.path) !== normPath(project.path))
      .map(gitWorktreeLabel)
  );
  let kbdIndex = $derived(nav.projectIndexHints[project.id] ?? null);
  let isActiveProject = $derived(nav.activeProjectId === project.id);
  let trimmedFilter = $derived(filter.trim());
  let showArchived = $derived(Boolean(sessions.showArchivedFor[project.id]));
  let archivedItems = $derived(sessions.archivedByProject[project.id] ?? []);
  let projectNameMatches = $derived.by(() => {
    if (!trimmedFilter) return false;
    return score(trimmedFilter, project.name) !== null
      || score(trimmedFilter, project.path) !== null;
  });
  let anyWorktreeLabelMatches = $derived.by(() => {
    if (!trimmedFilter) return false;
    return worktrees.some((wt) => score(trimmedFilter, wt.label) !== null);
  });
  let anySessionMatches = $derived.by(() => {
    if (!trimmedFilter) return false;
    return items.some((s) =>
      [s.name, s.cwd, ...(s.tags ?? [])].some((k) => score(trimmedFilter, k) !== null)
    );
  });
  let anyArchivedMatches = $derived.by(() => {
    if (!trimmedFilter || !showArchived) return false;
    return archivedItems.some((s) =>
      [s.name, s.cwd, ...(s.tags ?? [])].some((k) => score(trimmedFilter, k) !== null)
    );
  });
  let visibleSessions = $derived.by(() => {
    if (!trimmedFilter) return items;
    if (projectNameMatches) return items;
    return rankMulti(trimmedFilter, items, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });
  let visibleArchived = $derived.by(() => {
    if (!showArchived) return [];
    if (!trimmedFilter) return archivedItems;
    if (projectNameMatches) return archivedItems;
    return rankMulti(trimmedFilter, archivedItems, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });
  let hidden = $derived.by(() => {
    if (!trimmedFilter) return false;
    return !projectNameMatches && !anyWorktreeLabelMatches && !anySessionMatches && !anyArchivedMatches;
  });

  function edit() {
    projectModal.openEdit(project);
  }

  async function removeProject() {
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

  async function openFullRepo() {
    if (!mainWorktree) return;
    try {
      await projects.update(project.id, {
        name: basename(mainWorktree.path),
        path: mainWorktree.path
      });
    } catch (err) {
      reportError(err);
    }
  }
</script>

{#if !hidden}
<Collapsible.Root bind:open={expanded} class="flex flex-col gap-1.5">
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <div {...props} class="flex items-center gap-1 px-1 pt-1.5 pb-1">
          <Collapsible.Trigger
            class={cn(
              'group flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md border border-transparent px-2 py-1.5 text-left text-foreground transition-colors',
              isActiveProject ? 'bg-accent/60 border-border' : 'hover:bg-muted'
            )}
            aria-label={`Toggle ${project.name} project`}
          >
            {#if expanded}
              <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
            {:else}
              <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" />
            {/if}
            {#if accent}
              <span class="size-3 shrink-0 rounded-full" style={`background: ${accent}`}></span>
            {:else}
              <Folder class="size-3.5 shrink-0 text-muted-foreground" />
            {/if}
            <span class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="truncate text-sm leading-4 font-semibold">{project.name}</span>
              <span class="truncate font-mono text-[11px] leading-3.5 text-muted-foreground" title={project.path}>
                {project.path}
              </span>
            </span>
            {#if kbdIndex !== null}
              <KbdHint keys={['Ctrl', 'Shift', String(kbdIndex)]} class="shrink-0" />
            {/if}
          </Collapsible.Trigger>
          {#if !showWorktreeGroups}
            <AgentLaunchPopover
              projectId={project.id}
              cwd={project.path}
              title="New session"
              ariaLabel="New session"
            />
          {/if}
        </div>
      {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-56">
      <ContextMenu.Item onSelect={edit}>
        <Pencil /> <span>Edit project</span>
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => sessions.toggleArchivedFor(project.id)}>
        {#if showArchived}
          <ArchiveRestore />
          <span>Hide archived sessions</span>
        {:else}
          <Archive />
          <span>Show archived sessions{archivedItems.length > 0 ? ` (${archivedItems.length})` : ''}</span>
        {/if}
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item variant="destructive" onSelect={removeProject}>
        <Trash2 /> <span>Delete project</span>
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>

  <Collapsible.Content class="ml-3 flex flex-col gap-1.5 border-l border-border pl-2">
    {#if isStandaloneWorktreeProject && mainWorktree}
      <div class="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5">
        <div class="flex min-w-0 items-center gap-2">
          <FolderTree class="size-3.5 shrink-0 text-muted-foreground" />
          <div class="flex min-w-0 flex-1 flex-col leading-tight">
            <span class="truncate text-xs font-medium text-foreground" title={mainWorktree.path}>
              {repoName}
            </span>
            <span class="text-[10px] text-muted-foreground">
              Parent repo · {gitWorktrees.length} worktree{gitWorktrees.length === 1 ? '' : 's'}
            </span>
          </div>
          <Button
            variant="outline"
            size="xs"
            class="shrink-0 text-[10px]"
            title={`Open ${repoName} as the full worktree group`}
            onclick={openFullRepo}
          >
            Open repo
          </Button>
        </div>
        {#if otherWorktreeLabels.length > 0}
          <div class="flex flex-wrap items-center gap-1">
            {#each otherWorktreeLabels as label (label)}
              <Badge variant="outline" class="h-4 rounded-full px-1.5 font-mono text-[10px] font-normal">
                {label}
              </Badge>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if showWorktreeGroups}
      {#each worktrees as wt (wt.cwd)}
        <WorktreeGroup
          title={wt.label}
          cwd={wt.cwd}
          projectId={project.id}
          items={wt.items}
          isMain={wt.isMain}
          {filter}
          forceShow={projectNameMatches}
        />
      {/each}
    {:else if visibleSessions.length > 0}
      <div class="flex flex-col gap-px">
        {#each visibleSessions as session (session.id)}
          <SessionItem {session} branch={session.lastBranch ?? null} />
        {/each}
      </div>
    {:else}
      {#if loadingWorktrees}
        <p class="m-0 px-2.5 py-1 text-[11px] text-muted-foreground italic">Loading worktrees...</p>
      {:else if worktreeLoadFailed}
        <p class="m-0 px-2.5 py-1 text-[11px] text-muted-foreground italic">No worktrees found</p>
      {:else if filter.trim()}
        <p class="m-0 px-2.5 py-1 text-[11px] text-muted-foreground italic">No matching sessions</p>
      {:else}
        <p class="m-0 px-2.5 py-1 text-[11px] text-muted-foreground italic">No sessions</p>
      {/if}
    {/if}
    {#if showArchived && visibleArchived.length > 0}
      <div class="flex items-center gap-2 pt-1.5 pr-1 pl-1">
        <Archive class="size-3 shrink-0 text-muted-foreground" />
        <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          Archived
        </span>
        <span class="h-px flex-1 bg-border"></span>
        <span class="text-[10px] text-muted-foreground">{visibleArchived.length}</span>
      </div>
      <div class="flex flex-col gap-px opacity-70">
        {#each visibleArchived as session (session.id)}
          <SessionItem {session} branch={session.lastBranch ?? null} />
        {/each}
      </div>
    {:else if showArchived}
      <div class="flex items-center gap-2 pt-1.5 pr-1 pl-1">
        <Archive class="size-3 shrink-0 text-muted-foreground" />
        <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          Archived
        </span>
        <span class="h-px flex-1 bg-border"></span>
      </div>
      <p class="m-0 px-2.5 py-1 text-[11px] text-muted-foreground italic">
        {filter.trim() ? 'No matching archived sessions' : 'No archived sessions'}
      </p>
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
{/if}
