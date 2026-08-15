<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    Check,
    Folder,
    FolderTree,
    FolderPlus,
    Pencil,
    RefreshCcw,
    Trash2
  } from '@lucide/svelte';
  import type { GitWorktree } from '@shared/types/git.js';
  import type { Session } from '@shared/types/sessions.js';
  import type { Project, ProjectFavicon } from '@shared/types/projects.js';
  import type {
    MultiDeviceSessionView,
    ProjectView
  } from '@shared/types/multi-device-sessions.js';
  import type { DeviceId } from '@shared/types/devices.js';
  import { sessions } from '../stores/sessions.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { git } from '../stores/git.svelte';
  import { nav } from '../stores/nav.svelte';
  import { settings } from '../stores/settings.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { confirmStore } from '../stores/confirm.svelte';
  import { worktreeCreateModal } from '../stores/worktree-create-modal.svelte';
  import { ipc } from '../lib/ipc';
  import { rankMulti, score } from '../lib/fuzzy';
  import { cn } from '$lib/utils';
  import { Button } from '$lib/components/ui/button';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { dnd, DND_MIME, dropPositionFromEvent, type DropPosition } from '../stores/dnd.svelte';
  import { buildWorktreeGroups } from '../lib/worktree-groups';
  import { sameWorktreePath, worktreeBasename, worktreeLabel } from '../lib/worktree-path';
  import SessionItem from './SessionItem.svelte';
  import WorktreeGroup from './WorktreeGroup.svelte';
  import AgentLaunchPopover from './AgentLaunchPopover.svelte';

  let {
    project,
    sessions: items,
    filter = '',
    deviceProject = null,
    deviceFilter = null,
    showDevice = false,
    allowLocalActions = true,
    onProjectDrop = null
  }: {
    project: Project;
    sessions: Session[];
    filter?: string;
    deviceProject?: ProjectView | null;
    deviceFilter?: DeviceId | null;
    showDevice?: boolean;
    allowLocalActions?: boolean;
    onProjectDrop?:
      | ((args: { draggedId: string; targetId: string; position: DropPosition }) => void)
      | null;
  } = $props();

  let expanded = $state(true);
  let faviconsLoading = $state(false);
  let faviconsRequested = $state(false);
  let favicons = $state<ProjectFavicon[] | null>(null);
  let selectedFavicon = $state<ProjectFavicon | null>(null);
  let deviceWorkspaces = $derived.by(() => {
    if (!deviceProject) return [];
    return deviceProject.workspaces
      .map((workspace) => ({
        ...workspace,
        locations: workspace.locations.filter((location) =>
          deviceFilter === null || location.deviceId === deviceFilter
        ),
        sessions: workspace.sessions.filter((projection) =>
          deviceFilter === null || projection.ref.deviceId === deviceFilter
        )
      }))
      .filter((workspace) => workspace.locations.length > 0 || workspace.sessions.length > 0);
  });
  let deviceItems = $derived<MultiDeviceSessionView[]>(
    deviceWorkspaces.flatMap((workspace) => workspace.sessions)
  );
  let gitContext = $derived({
    ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
    ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
  });
  let gitWorktrees = $derived(git.worktreesFor(project.path, gitContext) ?? []);
  let loadingWorktrees = $derived(git.worktreesLoadingFor(project.path, gitContext));
  let worktreeLoadFailed = $derived(git.worktreesErrorFor(project.path, gitContext) !== null);

  function gitWorktreeLabel(worktree: GitWorktree): string {
    return worktree.branch
      ?? (worktree.detached
        ? 'detached'
        : worktreeLabel(project.path, worktree.path, project.defaultRunMode));
  }

  $effect(() => {
    if (!allowLocalActions) {
      selectedFavicon = null;
      return;
    }
    const projectId = project.id;
    const selectedPath = project.selectedFaviconPath;
    if (!selectedPath) {
      selectedFavicon = null;
      return;
    }
    let cancelled = false;
    void projects.readFavicon(projectId, selectedPath).then((favicon) => {
      if (!cancelled) selectedFavicon = favicon;
    }).catch(() => {
      if (!cancelled) selectedFavicon = null;
    });
    return () => {
      cancelled = true;
    };
  });

  let worktrees = $derived.by(() => buildWorktreeGroups({
    projectPath: project.path,
    ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
    worktrees: gitWorktrees,
    items,
    orderedPaths: project.worktreeOrder ?? []
  }));

  let accent = $derived(project.accentColor ?? null);
  let selectedFaviconPath = $derived(project.selectedFaviconPath ?? null);
  let mainWorktree = $derived(gitWorktrees.find((wt) => wt.isMain) ?? null);
  let hasWorktrees = $derived(gitWorktrees.some((wt) => !wt.isMain));
  let isStandaloneWorktreeProject = $derived(
    hasWorktrees
      && mainWorktree !== null
      && !sameWorktreePath(mainWorktree.path, project.path, project.defaultRunMode)
  );
  let showWorktreeGroups = $derived(
    (hasWorktrees || worktrees.length > 1) && !isStandaloneWorktreeProject
  );
  let repoName = $derived(mainWorktree ? worktreeBasename(mainWorktree.path) : project.name);
  let otherWorktreeLabels = $derived.by(() =>
    gitWorktrees
      .filter((wt) => !sameWorktreePath(wt.path, project.path, project.defaultRunMode))
      .map(gitWorktreeLabel)
  );
  let containsSelectedSession = $derived.by(() => {
    if (deviceProject) {
      return deviceItems.some((projection) => deviceSessions.isSelected(projection));
    }
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
  let kbdIndex = $derived.by<number | null>(() => {
    if (settings.current.shortcuts.shiftNumberNavigation !== 'project') return null;
    const index = projects.recents.findIndex((candidate) => candidate.id === project.id);
    return index >= 0 && index < 9 ? index + 1 : null;
  });

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
    if (deviceProject) {
      return deviceItems.some((projection) =>
        [projection.session.name, projection.session.cwd, projection.deviceName,
          ...(projection.session.tags ?? [])]
          .some((value) => score(trimmedFilter, value) !== null)
      );
    }
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
    if (!allowLocalActions) return;
    projectModal.openEdit(project);
  }

  async function refreshFavicons() {
    if (!allowLocalActions || faviconsLoading) return;
    faviconsRequested = true;
    faviconsLoading = true;
    try {
      favicons = await projects.refreshFavicons(project.id);
      selectedFavicon = favicons.find((favicon) => favicon.path === selectedFaviconPath)
        ?? selectedFavicon;
    } catch (err) {
      reportError(err);
    } finally {
      faviconsLoading = false;
    }
  }

  function onFaviconMenuOpenChange(open: boolean) {
    if (open && !faviconsRequested) {
      void refreshFavicons();
    }
  }

  function selectFavicon(favicon: ProjectFavicon) {
    selectedFavicon = favicon;
    void projects.update(project.id, { selectedFaviconPath: favicon.path }).catch(reportError);
  }

  async function removeProject() {
    if (!allowLocalActions) return;
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
    <div class="pointer-events-none absolute -top-0.5 right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
  {/if}
  {#if dropPosition === 'after'}
    <div class="pointer-events-none absolute -bottom-0.5 right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
  {/if}
<Collapsible.Root open={effectiveExpanded} onOpenChange={onProjectOpenChange} class="flex flex-col gap-1">
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <div
          {...props}
          data-project-id={project.id}
          class={cn('flex items-center gap-1', isDraggingSelf && 'opacity-40')}
        >
          <span class="relative flex min-w-0 flex-1">
            <Collapsible.Trigger
              class={cn(
                'group relative flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md border border-transparent px-1.5 py-1 text-left text-foreground transition-colors',
                isActiveProject ? 'bg-accent/60 border-border' : 'hover:bg-muted'
              )}
              aria-label={`Toggle ${project.name} project`}
              draggable={onProjectDrop ? 'true' : undefined}
              ondragstart={onProjectDragStart}
              ondragend={onProjectDragEnd}
            >
              {#if kbdIndex !== null}
                <span
                  class="pointer-events-none absolute top-0.5 left-0.5 font-mono text-[9px] leading-none text-muted-foreground/55"
                  title={`Ctrl/Cmd+Shift+${kbdIndex}`}
                  aria-label={`Ctrl or Command plus Shift plus ${kbdIndex}`}
                >
                  {kbdIndex}
                </span>
              {/if}
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
            </Collapsible.Trigger>
            <DropdownMenu.Root onOpenChange={onFaviconMenuOpenChange}>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    disabled={!allowLocalActions}
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
                {:else if favicons && favicons.length > 0}
                  {#each favicons as favicon (favicon.path)}
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
          {#if !showWorktreeGroups && (allowLocalActions || deviceProject)}
            {@const primaryWorkspace = deviceProject?.workspaces[0]}
            {@const primaryLocation = primaryWorkspace?.locations.find((candidate) => candidate.deviceId === deviceFilter)
              ?? primaryWorkspace?.locations.find((candidate) => deviceSessions.device(candidate.deviceId)?.local)
              ?? primaryWorkspace?.locations[0]}
            <AgentLaunchPopover
              projectId={allowLocalActions ? project.id : null}
              cwd={primaryLocation?.path ?? project.path}
              workspaceKey={primaryWorkspace?.key}
              defaultDeviceId={primaryLocation?.deviceId ?? null}
              title="New session"
              ariaLabel="New session"
            />
          {/if}
        </div>
      {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-56">
      <ContextMenu.Item disabled={!allowLocalActions} onSelect={edit}>
        <Pencil /> <span>Edit project</span>
      </ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item disabled={!allowLocalActions} variant="destructive" onSelect={removeProject}>
        <Trash2 /> <span>Delete project</span>
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>

  <Collapsible.Content class="ml-3 flex flex-col gap-1.5 border-l border-border pl-2">
    {#if deviceProject}
      {#each deviceWorkspaces as workspace (workspace.key)}
        {@const location = workspace.locations.find((candidate) => candidate.deviceId === deviceFilter)
          ?? workspace.locations.find((candidate) => deviceSessions.device(candidate.deviceId)?.local)
          ?? workspace.locations.find((candidate) => candidate.isMain)
          ?? workspace.locations[0]}
        {#if location}
          <WorktreeGroup
            title={workspace.branch ?? workspace.name}
            cwd={location.path}
            projectId={allowLocalActions ? project.id : null}
            items={workspace.sessions.map((projection) => projection.session)}
            projections={workspace.sessions}
            workspaceKey={workspace.key}
            defaultDeviceId={location.deviceId}
            isMain={location.isMain}
            {filter}
            forceShow={projectNameMatches}
            {showDevice}
            allowLocalActions={allowLocalActions && deviceSessions.device(location.deviceId)?.local === true}
            onWorktreeDrop={allowLocalActions && deviceSessions.device(location.deviceId)?.local
              ? onWorktreeDrop
              : null}
          />
        {/if}
      {:else}
        <p class="m-0 px-2.5 py-1 text-[11px] text-muted-foreground italic">No sessions</p>
      {/each}
    {:else}
    <button
      type="button"
      class="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onclick={() =>
        worktreeCreateModal.openFor(
          project,
          git.statusFor(project.path, gitContext)?.branch
        )}
    >
      <FolderPlus class="size-3" />
      <span>Add worktree…</span>
    </button>
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
          runMode={project.defaultRunMode}
          wslDistro={project.defaultWslDistro}
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
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
</div>
{/if}
