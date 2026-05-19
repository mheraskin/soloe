<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    Check,
    Folder,
    FolderTree,
    Pencil,
    RefreshCcw,
    Trash2
  } from '@lucide/svelte';
  import type { GitWorktree } from '@shared/types/git.js';
  import type { Session } from '@shared/types/sessions.js';
  import type { Project, ProjectFavicon } from '@shared/types/projects.js';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { git } from '../stores/git.svelte';
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
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { dnd, DND_MIME, dropPositionFromEvent, type DropPosition } from '../stores/dnd.svelte';
  import KbdHint from './KbdHint.svelte';
  import SessionItem from './SessionItem.svelte';
  import WorktreeGroup from './WorktreeGroup.svelte';
  import AgentLaunchPopover from './AgentLaunchPopover.svelte';

  let {
    project,
    sessions: items,
    filter = '',
    onProjectDrop = null
  }: {
    project: Project;
    sessions: Session[];
    filter?: string;
    onProjectDrop?:
      | ((args: { draggedId: string; targetId: string; position: DropPosition }) => void)
      | null;
  } = $props();

  let expanded = $state(true);
  let faviconsLoading = $state(false);
  let faviconsRequested = $state(false);
  let gitWorktrees = $derived(git.worktreesFor(project.path) ?? []);
  let loadingWorktrees = $derived(git.worktreesLoadingFor(project.path));
  let worktreeLoadFailed = $derived(git.worktreesErrorFor(project.path) !== null);

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
    void git.loadWorktrees(project.path, false, {
      ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
      ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
    });
  });

  $effect(() => {
    if (faviconsRequested || project.favicons !== undefined) return;
    faviconsRequested = true;
    void refreshFavicons();
  });

  let worktrees = $derived.by<{ cwd: string; label: string; isMain: boolean; items: Session[] }[]>(() => {
    const naturalOrder: string[] = [];
    const buckets: Record<string, Session[]> = {};
    for (const worktree of gitWorktrees) {
      const key = normPath(worktree.path);
      if (!buckets[key]) {
        buckets[key] = [];
        naturalOrder.push(key);
      }
    }
    for (const s of items) {
      const key = normPath(s.cwd);
      if (!buckets[key]) {
        buckets[key] = [];
        naturalOrder.push(key);
      }
      buckets[key].push(s);
    }
    // Apply user-defined worktree order. Entries the user hasn't placed yet
    // (newly-discovered git worktrees, sessions in unfamiliar cwds) keep their
    // natural position relative to each other and slot in at the end.
    const userOrder = (project.worktreeOrder ?? []).map(normPath);
    const seen = new Set<string>();
    const finalOrder: string[] = [];
    for (const key of userOrder) {
      if (buckets[key] && !seen.has(key)) {
        seen.add(key);
        finalOrder.push(key);
      }
    }
    for (const key of naturalOrder) {
      if (!seen.has(key)) {
        seen.add(key);
        finalOrder.push(key);
      }
    }
    return finalOrder.map((key) => {
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
  let selectedFaviconPath = $derived(project.selectedFaviconPath ?? project.favicons?.[0]?.path ?? null);
  let selectedFavicon = $derived(
    project.favicons?.find((f) => f.path === selectedFaviconPath) ?? project.favicons?.[0] ?? null
  );
  let mainWorktree = $derived(gitWorktrees.find((wt) => wt.isMain) ?? null);
  let hasWorktrees = $derived(gitWorktrees.some((wt) => !wt.isMain));
  let isStandaloneWorktreeProject = $derived(
    hasWorktrees
      && mainWorktree !== null
      && normPath(mainWorktree.path) !== normPath(project.path)
  );
  let showWorktreeGroups = $derived(
    (hasWorktrees || worktrees.length > 1) && !isStandaloneWorktreeProject
  );
  let repoName = $derived(mainWorktree ? basename(mainWorktree.path) : project.name);
  let otherWorktreeLabels = $derived.by(() =>
    gitWorktrees
      .filter((wt) => normPath(wt.path) !== normPath(project.path))
      .map(gitWorktreeLabel)
  );
  let kbdIndex = $derived(nav.projectIndexHints[project.id] ?? null);
  let containsSelectedSession = $derived.by(() => {
    const selId = sessions.selectedId;
    if (!selId) return false;
    return items.some((s) => s.id === selId);
  });
  let trimmedFilter = $derived(filter.trim());
  let isFiltering = $derived(trimmedFilter.length > 0);
  // Force every project open while the user is filtering so matches are
  // reachable. `expanded` keeps the user's saved preference untouched, so
  // clearing the filter restores the original collapse state.
  let effectiveExpanded = $derived(isFiltering ? true : expanded);
  // Highlight the project header as "selected" when its content is collapsed
  // (so the actual session row is hidden) — keeps a visual anchor for the
  // active session even when the user collapses its parents.
  let isActiveProject = $derived(
    nav.activeProjectId === project.id
      || (containsSelectedSession && !effectiveExpanded)
  );

  function onProjectOpenChange(open: boolean) {
    if (isFiltering) return;
    expanded = open;
  }
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
  let visibleSessions = $derived.by(() => {
    if (!trimmedFilter) return items;
    if (projectNameMatches) return items;
    return rankMulti(trimmedFilter, items, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });
  let hidden = $derived.by(() => {
    if (!trimmedFilter) return false;
    return !projectNameMatches && !anyWorktreeLabelMatches && !anySessionMatches;
  });

  function edit() {
    projectModal.openEdit(project);
  }

  async function refreshFavicons() {
    if (faviconsLoading) return;
    faviconsLoading = true;
    try {
      await projects.refreshFavicons(project.id);
    } catch (err) {
      reportError(err);
    } finally {
      faviconsLoading = false;
    }
  }

  function onFaviconMenuOpenChange(open: boolean) {
    if (open && (project.favicons === undefined || project.favicons.length === 0)) {
      void refreshFavicons();
    }
  }

  function selectFavicon(favicon: ProjectFavicon) {
    void projects.update(project.id, { selectedFaviconPath: favicon.path }).catch(reportError);
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
      // Promote to the full repo without renaming — the project is the same
      // logical thing, just rooted at the parent so worktree groups show up.
      await projects.update(project.id, {
        path: mainWorktree.path
      });
    } catch (err) {
      reportError(err);
    }
  }

  function onInlineSessionDrop(args: { draggedId: string; targetId: string; position: DropPosition }) {
    const { draggedId, targetId, position } = args;
    const ids = items.map((s) => s.id);
    if (!ids.includes(draggedId) || !ids.includes(targetId)) return;
    const without = ids.filter((id) => id !== draggedId);
    let insertAt = without.indexOf(targetId);
    if (insertAt < 0) insertAt = without.length;
    if (position === 'after') insertAt += 1;
    const newSubset = [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
    if (sameOrder(ids, newSubset)) return;
    const subsetSet = new Set(ids);
    const queue = [...newSubset];
    const allIds = sessions.sessions.map((s) => {
      if (subsetSet.has(s.id)) return queue.shift() ?? s.id;
      return s.id;
    });
    void sessions.reorder(allIds).catch(reportError);
  }

  function onWorktreeDrop(args: { draggedCwd: string; targetCwd: string; position: DropPosition }) {
    const { draggedCwd, targetCwd, position } = args;
    const ids = worktrees.map((w) => w.cwd);
    if (!ids.includes(draggedCwd) || !ids.includes(targetCwd)) return;
    const without = ids.filter((id) => id !== draggedCwd);
    let insertAt = without.indexOf(targetCwd);
    if (insertAt < 0) insertAt = without.length;
    if (position === 'after') insertAt += 1;
    const next = [...without.slice(0, insertAt), draggedCwd, ...without.slice(insertAt)];
    if (sameOrder(ids, next)) return;
    void projects.update(project.id, { worktreeOrder: next }).catch(reportError);
  }

  function sameOrder(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  // Bound to the outermost wrapper so the entire section (header + expanded
  // content) acts as the drop zone, and so before/after is computed from the
  // section's full bounds — the indicator stays under the cursor as the user
  // drags through an open project's children.
  let wrapperEl: HTMLElement | null = $state(null);
  let dropPosition = $derived.by<DropPosition | null>(() => {
    if (!onProjectDrop) return null;
    const t = dnd.target;
    if (!t || t.kind !== 'project' || t.id !== project.id) return null;
    if (dnd.drag?.id === project.id) return null;
    return t.position;
  });
  let isDraggingSelf = $derived(dnd.drag?.kind === 'project' && dnd.drag.id === project.id);

  function onProjectDragStart(e: DragEvent) {
    if (!onProjectDrop || !e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DND_MIME.project, project.id);
    dnd.begin({ kind: 'project', id: project.id, projectId: project.id, worktreeCwd: null });
  }

  function onProjectDragOver(e: DragEvent) {
    if (!onProjectDrop || !wrapperEl) return;
    if (dnd.drag?.kind !== 'project') return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const position = dropPositionFromEvent(e, wrapperEl);
    if (
      dnd.target?.kind !== 'project'
      || dnd.target.id !== project.id
      || dnd.target.position !== position
    ) {
      dnd.setTarget({ kind: 'project', id: project.id, position });
    }
  }

  function onProjectDropEvent(e: DragEvent) {
    if (!onProjectDrop) return;
    if (dnd.drag?.kind !== 'project') return;
    const draggedId = dnd.drag.id;
    if (draggedId === project.id) return;
    e.preventDefault();
    const position = dnd.target?.kind === 'project' && dnd.target.id === project.id
      ? dnd.target.position
      : 'after';
    onProjectDrop({ draggedId, targetId: project.id, position });
    dnd.end();
  }

  function onProjectDragEnd() {
    dnd.end();
  }
</script>

{#if !hidden}
<div
  bind:this={wrapperEl}
  role="group"
  class="relative"
  ondragover={onProjectDragOver}
  ondrop={onProjectDropEvent}
>
  {#if dropPosition === 'before'}
    <div class="pointer-events-none absolute -top-1.5 right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
  {/if}
  {#if dropPosition === 'after'}
    <div class="pointer-events-none absolute -bottom-1.5 right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
  {/if}
<Collapsible.Root open={effectiveExpanded} onOpenChange={onProjectOpenChange} class="flex flex-col gap-1.5">
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <div
          {...props}
          data-project-id={project.id}
          class={cn('flex items-center gap-1 px-1 pt-1.5 pb-1', isDraggingSelf && 'opacity-40')}
          draggable={onProjectDrop ? 'true' : undefined}
          ondragstart={onProjectDragStart}
          ondragend={onProjectDragEnd}
        >
          <span class="relative flex min-w-0 flex-1">
            <Collapsible.Trigger
              class={cn(
                'group flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md border border-transparent px-2 py-1.5 text-left text-foreground transition-colors',
                isActiveProject ? 'bg-accent/60 border-border' : 'hover:bg-muted'
              )}
              aria-label={`Toggle ${project.name} project`}
            >
              {#if effectiveExpanded}
                <ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
              {:else}
                <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" />
              {/if}
              {#if selectedFavicon}
                <img
                  src={selectedFavicon.dataUrl}
                  alt=""
                  class="size-3.5 shrink-0 rounded-sm object-contain"
                />
              {:else if accent}
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
            <DropdownMenu.Root onOpenChange={onFaviconMenuOpenChange}>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="absolute top-1/2 left-[30px] z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm bg-transparent text-transparent outline-none transition-colors hover:bg-muted/80 focus-visible:ring-2 focus-visible:ring-ring/50"
                    title="Project icon"
                    aria-label={`Choose icon for ${project.name}`}
                  >
                    <span class="sr-only">Choose project icon</span>
                  </button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" side="bottom" class="w-64">
                <DropdownMenu.Label>Project icon</DropdownMenu.Label>
                {#if faviconsLoading}
                  <DropdownMenu.Item disabled>
                    <RefreshCcw class="animate-spin" />
                    <span>Scanning...</span>
                  </DropdownMenu.Item>
                {:else if project.favicons && project.favicons.length > 0}
                  {#each project.favicons as favicon (favicon.path)}
                    <DropdownMenu.Item onSelect={() => selectFavicon(favicon)}>
                      <img
                        src={favicon.dataUrl}
                        alt=""
                        class="size-4 rounded-sm object-contain"
                      />
                      <span class="min-w-0 flex-1 truncate" title={favicon.path}>{favicon.label}</span>
                      {#if favicon.path === selectedFaviconPath}
                        <Check class="ml-auto size-3" />
                      {/if}
                    </DropdownMenu.Item>
                  {/each}
                {:else}
                  <DropdownMenu.Item disabled>
                    <Folder />
                    <span>No favicons found</span>
                  </DropdownMenu.Item>
                {/if}
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => void refreshFavicons()}>
                  <RefreshCcw />
                  <span>Refresh favicons</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </span>
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
      <ContextMenu.Separator />
      <ContextMenu.Item variant="destructive" onSelect={removeProject}>
        <Trash2 /> <span>Delete project</span>
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>

  <Collapsible.Content class="ml-3 flex flex-col gap-1.5 border-l border-border pl-2">
    {#if isStandaloneWorktreeProject && mainWorktree}
      <div class="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        <FolderTree class="size-3 shrink-0" />
        <span
          class="min-w-0 flex-1 truncate"
          title={otherWorktreeLabels.length > 0
            ? `Other worktrees: ${otherWorktreeLabels.join(', ')}`
            : mainWorktree.path}
        >
          Worktree of <span class="text-foreground">{repoName}</span>{#if otherWorktreeLabels.length > 0} · {otherWorktreeLabels.length} more{/if}
        </span>
        <Button
          variant="ghost"
          size="xs"
          class="h-5 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          title="Open full repo with all worktrees"
          onclick={openFullRepo}
        >
          Open repo
        </Button>
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
          {onWorktreeDrop}
        />
      {/each}
    {:else if visibleSessions.length > 0}
      <div class="flex flex-col gap-px">
        {#each visibleSessions as session (session.id)}
          <SessionItem
            {session}
            branch={session.lastBranch ?? null}
            onSessionDrop={onInlineSessionDrop}
          />
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
  </Collapsible.Content>
</Collapsible.Root>
</div>
{/if}
