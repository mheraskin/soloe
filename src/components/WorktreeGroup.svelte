<script lang="ts">
  import { BookOpen, ChevronDown, ChevronRight, FolderGit2 } from '@lucide/svelte';
  import type { RunMode, Session, SessionId } from '@shared/types/sessions.js';
  import type { ProjectId } from '@shared/types/projects.js';
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import type { DeviceId } from '@shared/types/devices.js';
  import { sessions } from '../stores/sessions.svelte';
  import { nav } from '../stores/nav.svelte';
  import { settings } from '../stores/settings.svelte';
  import { git } from '../stores/git.svelte';
  import { sidebarExpansion } from '../stores/sidebar-expansion.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { rankMulti, score } from '../lib/fuzzy';
  import { cn } from '$lib/utils';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import { dnd, DND_MIME, dropPositionFromEvent, type DropPosition } from '../stores/dnd.svelte';
  import SessionItem from './SessionItem.svelte';
  import AgentLaunchPopover from './AgentLaunchPopover.svelte';
  import WorktreeOverviewDialog from './WorktreeOverviewDialog.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';

  let {
    title,
    cwd,
    projectId,
    items,
    projections = null,
    workspaceKey,
    defaultDeviceId = null,
    showDevice = false,
    allowLocalActions = true,
    runMode,
    wslDistro,
    isMain = false,
    filter = '',
    forceShow = false,
    onWorktreeDrop = null
  }: {
    title: string;
    cwd: string;
    projectId: ProjectId | null;
    items: Session[];
    projections?: MultiDeviceSessionView[] | null;
    workspaceKey?: string;
    defaultDeviceId?: DeviceId | null;
    showDevice?: boolean;
    allowLocalActions?: boolean;
    runMode?: RunMode;
    wslDistro?: string;
    isMain?: boolean;
    filter?: string;
    forceShow?: boolean;
    onWorktreeDrop?:
      | ((args: { draggedCwd: string; targetCwd: string; position: DropPosition }) => void)
      | null;
  } = $props();

  let expanded = $derived(sidebarExpansion.isExpanded(cwd));
  let overviewOpen = $state(false);

  let trimmedFilter = $derived(filter.trim());
  let labelMatches = $derived.by(() => {
    if (!trimmedFilter) return false;
    return score(trimmedFilter, title) !== null;
  });
  let visible = $derived.by(() => {
    if (!trimmedFilter) return items;
    if (forceShow || labelMatches) return items;
    return rankMulti(trimmedFilter, items, (s) => [s.name, s.cwd, ...(s.tags ?? [])]).map((r) => r.item);
  });
  let visibleProjections = $derived.by(() => {
    if (!projections) return null;
    if (!trimmedFilter || forceShow || labelMatches) return projections;
    return rankMulti(trimmedFilter, projections, (projection) => [
      projection.session.name,
      projection.session.cwd,
      projection.deviceName,
      ...(projection.session.tags ?? [])
    ]).map((result) => result.item);
  });
  let hidden = $derived(
    trimmedFilter.length > 0
      && !forceShow
      && !labelMatches
      && (visibleProjections?.length ?? visible.length) === 0
  );
  let isFiltering = $derived(trimmedFilter.length > 0);
  // While filtering we force the group open so matches stay reachable; the
  // user's saved `expanded` is preserved and restored once the filter clears.
  let effectiveExpanded = $derived(isFiltering ? true : expanded);
  let containsSelected = $derived.by(() => {
    if (projections) return projections.some((projection) => deviceSessions.isSelected(projection));
    const selId = sessions.selectedId;
    if (!selId) return false;
    return items.some((s) => s.id === selId);
  });
  // When the worktree group is collapsed but holds the selected session, the
  // header takes on the selected look so the user keeps a visual anchor.
  let highlightWhenCollapsed = $derived(containsSelected && !effectiveExpanded);

  let shortstat = $derived(allowLocalActions ? git.shortstatFor(cwd, {
    ...(runMode ? { runMode } : {}),
    ...(wslDistro ? { wslDistro } : {})
  }) : null);
  let hasDiff = $derived(
    !!shortstat && shortstat.isRepo && (shortstat.insertions > 0 || shortstat.deletions > 0)
  );
  let kbdIndex = $derived(
    allowLocalActions && settings.current.shortcuts.shiftNumberNavigation === 'worktree'
      ? nav.worktreeIndexHints[cwd] ?? null
      : null
  );
  let diffTitle = $derived.by<string>(() => {
    if (!shortstat || !shortstat.isRepo) return '';
    if (shortstat.insertions === 0 && shortstat.deletions === 0) return 'no changes';
    return `${shortstat.filesChanged} file${shortstat.filesChanged === 1 ? '' : 's'} changed · +${shortstat.insertions} −${shortstat.deletions}`;
  });

  function onGroupOpenChange(open: boolean) {
    if (isFiltering) return;
    sidebarExpansion.setExpanded(cwd, open);
  }

  function onSessionDrop(args: { draggedId: SessionId; targetId: SessionId; position: DropPosition }) {
    const { draggedId, targetId, position } = args;
    // Reorder is constrained to siblings inside this worktree group only.
    // Sessions from other worktrees keep their relative position; only the
    // members of this group get a new linear order.
    const ids = projections
      ? projections.map((projection) => projection.key)
      : items.map((session) => session.id);
    if (!ids.includes(draggedId) || !ids.includes(targetId)) return;
    const without = ids.filter((id) => id !== draggedId);
    let insertAt = without.indexOf(targetId);
    if (insertAt < 0) insertAt = without.length;
    if (position === 'after') insertAt += 1;
    const newSubset = [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
    if (sameOrder(ids, newSubset)) return;

    if (projections) {
      const byKey = new Map(projections.map((projection) => [projection.key, projection]));
      const ordered = newSubset
        .map((key) => byKey.get(key))
        .filter((projection): projection is MultiDeviceSessionView => projection !== undefined);
      void deviceSessions.reorder(ordered).catch(reportError);
      return;
    }

    const subsetSet = new Set(ids);
    const queue = [...newSubset];
    const allIds = sessions.sessions.map((s) => {
      if (subsetSet.has(s.id)) return queue.shift() ?? s.id;
      return s.id;
    });
    void sessions.reorder(allIds).catch(reportError);
  }

  function sameOrder(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  // Wrapper covers the header AND the expanded session list, so the drop
  // indicator keeps tracking the cursor when it moves into the open content.
  let wrapperEl: HTMLElement | null = $state(null);
  let dropPosition = $derived.by<DropPosition | null>(() => {
    if (!onWorktreeDrop) return null;
    const t = dnd.target;
    if (!t || t.kind !== 'worktree' || t.id !== cwd) return null;
    if (dnd.drag?.id === cwd) return null;
    return t.position;
  });
  let isDraggingSelf = $derived(dnd.drag?.kind === 'worktree' && dnd.drag.id === cwd);

  function onHeaderDragStart(e: DragEvent) {
    if (!onWorktreeDrop || !e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DND_MIME.worktree, cwd);
    dnd.begin({ kind: 'worktree', id: cwd, projectId, worktreeCwd: cwd });
  }

  function onHeaderDragOver(e: DragEvent) {
    if (!onWorktreeDrop || !wrapperEl) return;
    if (dnd.drag?.kind !== 'worktree') return;
    if (dnd.drag.projectId !== projectId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const position = dropPositionFromEvent(e, wrapperEl);
    if (
      dnd.target?.kind !== 'worktree'
      || dnd.target.id !== cwd
      || dnd.target.position !== position
    ) {
      dnd.setTarget({ kind: 'worktree', id: cwd, position });
    }
  }

  function onHeaderDrop(e: DragEvent) {
    if (!onWorktreeDrop) return;
    if (dnd.drag?.kind !== 'worktree') return;
    if (dnd.drag.projectId !== projectId) return;
    const draggedCwd = dnd.drag.id;
    if (draggedCwd === cwd) return;
    e.preventDefault();
    const position = dnd.target?.kind === 'worktree' && dnd.target.id === cwd
      ? dnd.target.position
      : 'after';
    onWorktreeDrop({ draggedCwd, targetCwd: cwd, position });
    dnd.end();
  }

  function onHeaderDragEnd() {
    dnd.end();
  }
</script>

{#if !hidden}
  <div
    bind:this={wrapperEl}
    role="group"
    class="relative"
    ondragover={onHeaderDragOver}
    ondrop={onHeaderDrop}
  >
    {#if dropPosition === 'before'}
      <div class="pointer-events-none absolute -top-0.5 right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
    {/if}
    {#if dropPosition === 'after'}
      <div class="pointer-events-none absolute -bottom-0.5 right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
    {/if}
  <Collapsible.Root open={effectiveExpanded} onOpenChange={onGroupOpenChange} class="flex flex-col gap-1">
    <div
      role="group"
      class={cn('flex items-center gap-1 px-0.5 py-0.5', isDraggingSelf && 'opacity-40')}
    >
      <Collapsible.Trigger
        class={cn(
          'relative flex flex-1 items-center gap-2 overflow-hidden rounded-md border border-transparent px-2 py-1 text-left transition-colors',
          highlightWhenCollapsed
            ? 'bg-accent/60 border-border text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
        aria-label={`Toggle worktree ${title}`}
        draggable={onWorktreeDrop ? 'true' : undefined}
        ondragstart={onHeaderDragStart}
        ondragend={onHeaderDragEnd}
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
          <ChevronDown class="size-3 shrink-0" />
        {:else}
          <ChevronRight class="size-3 shrink-0" />
        {/if}
        <FolderGit2 class="size-3.5 shrink-0" />
        <span class="flex-1 truncate font-mono text-xs leading-4" title={cwd}>{title}</span>
        {#if hasDiff && shortstat}
          <span
            class="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums"
            title={diffTitle}
            aria-label={diffTitle}
          >
            {#if shortstat.insertions > 0}
              <span class="text-emerald-500">+{shortstat.insertions}</span>
            {/if}
            {#if shortstat.deletions > 0}
              <span class="text-rose-500">−{shortstat.deletions}</span>
            {/if}
          </span>
        {/if}
        {#if isMain}
          <Badge variant="outline" class="h-4 rounded-full px-1.5 text-[9px] font-medium tracking-wider uppercase">main</Badge>
        {/if}
        <Badge variant="secondary" class="h-4 rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          {projections?.length ?? items.length}
        </Badge>
      </Collapsible.Trigger>
      {#if allowLocalActions}<Button
        variant="ghost"
        size="icon-sm"
        class="shrink-0"
        title="Worktree overview"
        aria-label="Worktree overview"
        onclick={() => (overviewOpen = true)}
      >
        <BookOpen />
      </Button>
      {/if}
      <AgentLaunchPopover
        {projectId}
        {cwd}
        branch={title}
        {workspaceKey}
        {defaultDeviceId}
        title="New session in this worktree"
        ariaLabel="New session in this worktree"
      />
    </div>
    <Collapsible.Content class="flex flex-col gap-px pl-4">
      {#if visibleProjections}
        {#each visibleProjections as projection (projection.key)}
          <SessionItem
            session={projection.session}
            branch={title}
            {projection}
            {showDevice}
            {onSessionDrop}
          />
        {/each}
      {:else}
        {#each visible as session (session.id)}
          <SessionItem {session} branch={title} {onSessionDrop} />
        {/each}
      {/if}
    </Collapsible.Content>
  </Collapsible.Root>
  </div>
  {#if allowLocalActions}<WorktreeOverviewDialog bind:open={overviewOpen} {cwd} branch={title} />{/if}
{/if}
