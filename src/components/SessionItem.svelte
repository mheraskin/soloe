<script lang="ts">
  import { tick } from 'svelte';
  import {
    Archive,
    ArchiveRestore,
    Loader2,
    Pencil,
    FolderOpen,
    Copy,
    Trash2,
    GitBranch,
    ChevronRight,
    CircleSlash
  } from '@lucide/svelte';
  import type {
    AgentObservedState,
    Session,
    SessionId,
    SessionColor
  } from '@shared/types/sessions.js';
  import { SESSION_COLOR_TOKENS } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { agentNotifications } from '../stores/agent-notifications.svelte';
  import { nav } from '../stores/nav.svelte';
  import { modal } from '../stores/modal.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import { confirmDeleteSession } from '../lib/session-delete-confirmation';
  import { cn } from '$lib/utils';
  import { Button } from '$lib/components/ui/button';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import { dnd, DND_MIME, dropPositionFromEvent, type DropPosition } from '../stores/dnd.svelte';
  import KindIcon from './KindIcon.svelte';
  import KbdHint from './KbdHint.svelte';
  import AgentStateBadge from './AgentStateBadge.svelte';

  type StatusTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

  interface StatusPill {
    label: string;
    title: string;
    tone: StatusTone;
  }

  let {
    session,
    branch = null,
    onSessionDrop = null
  }: {
    session: Session;
    branch?: string | null;
    onSessionDrop?:
      | ((args: { draggedId: SessionId; targetId: SessionId; position: DropPosition }) => void)
      | null;
  } = $props();

  let editing = $state(false);
  let editValue = $state('');
  let nameInput: HTMLInputElement | null = $state(null);
  let menuOpen = $state(false);
  let paletteExpanded = $state(false);

  const COLOR_LABELS: Record<SessionColor, string> = {
    red: 'Red',
    orange: 'Orange',
    amber: 'Amber',
    yellow: 'Yellow',
    green: 'Green',
    teal: 'Teal',
    cyan: 'Cyan',
    blue: 'Blue',
    violet: 'Violet',
    pink: 'Pink'
  };

  const QUICK_COLORS: readonly SessionColor[] = ['red', 'amber', 'green', 'blue', 'violet'];

  let isSelected = $derived(sessions.selectedId === session.id);
  let status = $derived(sessions.statusFor(session.id));
  let observed = $derived(sessions.observationFor(session.id));
  let latestEvent = $derived(sessions.eventsFor(session.id)[0] ?? null);
  let observedSummary = $derived(
    latestEvent?.state === observed?.state
      ? latestEvent?.summary ?? null
      : observed?.resultSummary ?? observed?.promptSummary ?? null
  );
  let marker = $derived(agentNotifications.markerFor(session.id));
  let markerPulses = $derived(agentNotifications.pulsingSessionId === session.id);
  let workerCount = $derived(sessions.childWorkersFor(session.id).length);
  let kbdIndex = $derived(nav.sessionIndexHints[session.id] ?? null);
  // hasRuntime distinguishes "user has launched this at least once in this app
  // session" from the cold pre-spawn state, where we want neither pill nor
  // spinner.
  let hasRuntime = $derived(sessions.runtime[session.id] !== undefined);
  let isAgent = $derived(session.kind === 'claude_code' || session.kind === 'codex');
  let displayedAgentState = $derived.by<AgentObservedState | null>(() => {
    if (!observed) return null;
    if (observed.state === 'starting') {
      return status === 'running' ? 'idle' : null;
    }
    return observed.state;
  });
  let displayedObservedSummary = $derived(
    observed?.state === 'starting' && displayedAgentState === 'idle' ? 'idle' : observedSummary
  );
  let showSpawnSpinner = $derived(hasRuntime && status === 'starting');
  let showAgentBadge = $derived(isAgent && displayedAgentState !== null);
  let statusPill = $derived(buildStatusPill());

  function onClick(e: MouseEvent) {
    if (e.button !== 0 || editing) return;
    if (isSelected) sessions.select(null);
    else sessions.select(session.id);
  }

  async function startEditing(e?: Event) {
    e?.stopPropagation();
    if (editing) return;
    editValue = session.name;
    editing = true;
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }

  function cancelEditing() {
    editing = false;
    editValue = '';
  }

  async function commitEditing() {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === session.name) {
      cancelEditing();
      return;
    }
    const next = trimmed;
    editing = false;
    editValue = '';
    try {
      await sessions.update(session.id, { name: next, autoNamed: false });
    } catch (err) {
      reportError(err);
    }
  }

  function onNameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitEditing();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  }

  function onRowKey(e: KeyboardEvent) {
    if (editing) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isSelected) sessions.select(null);
      else sessions.select(session.id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      void startEditing();
    }
  }

  async function start() {
    try { await sessions.start(session.id); } catch (err) { reportError(err); }
  }
  async function stop() {
    try { await sessions.stop(session.id); } catch (err) { reportError(err); }
  }
  async function restart() {
    try { await sessions.restart(session.id); } catch (err) { reportError(err); }
  }
  function edit() {
    modal.openEdit(session);
  }
  async function remove() {
    const ok = await confirmDeleteSession(session);
    if (!ok) return;
    try { await sessions.remove(session.id); } catch (err) { reportError(err); }
  }
  async function archive(e?: Event) {
    e?.stopPropagation();
    try { await sessions.archive(session.id); } catch (err) { reportError(err); }
  }
  async function restore(e?: Event) {
    e?.stopPropagation();
    try { await sessions.restore(session.id); } catch (err) { reportError(err); }
  }
  function restoreFromButton(e: Event) {
    e.stopPropagation();
    void restore();
  }
  function removeFromButton(e: Event) {
    e.stopPropagation();
    void remove();
  }
  async function openCwd() {
    try { await ipc.system.openPath(session.id); } catch (err) { reportError(err); }
  }
  async function copyCmd() {
    try {
      const spec = await ipc.sessions.previewCommand(session.id);
      await navigator.clipboard.writeText(spec.description);
    } catch (err) {
      reportError(err);
    }
  }

  async function setColor(color: SessionColor | null) {
    if ((session.color ?? null) === color) return;
    try {
      await sessions.update(session.id, { color: color ?? undefined });
    } catch (err) {
      reportError(err);
    }
  }

  function colorVar(color: SessionColor): string {
    return `var(--session-${color})`;
  }

  let canStart = $derived(status === 'stopped' || status === 'exited' || status === 'error');
  let isRunning = $derived(status === 'running' || status === 'starting');

  // Fallback for agents that predate observer snapshots or failed before one
  // was emitted. AgentStateBadge is the primary agent state pill.
  function buildStatusPill(): StatusPill | null {
    if (!hasRuntime || !isAgent) return null;
    if (status !== 'exited' && status !== 'error') return null;
    return {
      label: status,
      title: status,
      tone: status === 'error' ? 'danger' : 'neutral'
    };
  }

  function pillClass(tone: StatusTone): string {
    const classes = {
      neutral: 'border-border bg-muted/40 text-muted-foreground',
      primary: 'border-primary/40 bg-primary/10 text-primary',
      success: 'border-success/40 bg-success/10 text-success',
      warning: 'border-warning/40 bg-warning/10 text-warning',
      danger: 'border-destructive/40 bg-destructive/10 text-destructive'
    } satisfies Record<StatusTone, string>;
    return classes[tone];
  }

  let rowEl: HTMLElement | null = $state(null);
  let dropPosition = $derived.by<DropPosition | null>(() => {
    if (!onSessionDrop) return null;
    const t = dnd.target;
    if (!t || t.kind !== 'session' || t.id !== session.id) return null;
    if (dnd.drag?.id === session.id) return null;
    return t.position;
  });
  let isDraggingSelf = $derived(dnd.drag?.kind === 'session' && dnd.drag.id === session.id);

  function onDragStart(e: DragEvent) {
    if (!onSessionDrop || !e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DND_MIME.session, session.id);
    dnd.begin({
      kind: 'session',
      id: session.id,
      projectId: session.projectId ?? null,
      worktreeCwd: session.cwd
    });
  }

  function onDragOver(e: DragEvent) {
    if (!onSessionDrop || !rowEl) return;
    if (dnd.drag?.kind !== 'session') return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const position = dropPositionFromEvent(e, rowEl);
    if (
      dnd.target?.kind !== 'session'
      || dnd.target.id !== session.id
      || dnd.target.position !== position
    ) {
      dnd.setTarget({ kind: 'session', id: session.id, position });
    }
  }

  function onDrop(e: DragEvent) {
    if (!onSessionDrop) return;
    if (dnd.drag?.kind !== 'session') return;
    const draggedId = dnd.drag.id;
    if (draggedId === session.id) return;
    e.preventDefault();
    const position = dnd.target?.kind === 'session' && dnd.target.id === session.id
      ? dnd.target.position
      : 'after';
    onSessionDrop({ draggedId, targetId: session.id, position });
    dnd.end();
  }

  function onDragEnd() {
    dnd.end();
  }

  let rowStyle = $derived(
    session.color ? `--row-color: var(--session-${session.color});` : undefined
  );

  let visibleColors = $derived(
    paletteExpanded
      ? [...SESSION_COLOR_TOKENS]
      : SESSION_COLOR_TOKENS.filter(
          (c) => QUICK_COLORS.includes(c) || c === session.color
        )
  );
</script>

<div class="relative">
  {#if dropPosition === 'before'}
    <div class="pointer-events-none absolute -top-px right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
  {/if}
  {#if dropPosition === 'after'}
    <div class="pointer-events-none absolute -bottom-px right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
  {/if}
<ContextMenu.Root
  open={menuOpen}
  onOpenChange={(v) => {
    menuOpen = v;
    if (!v) paletteExpanded = false;
  }}
>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <div
        {...props}
        bind:this={rowEl}
        data-session-id={session.id}
        data-row-color={session.color ?? undefined}
        data-row-selected={isSelected ? 'true' : undefined}
        class={cn(
          'session-row group relative flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors',
          !session.color && 'hover:bg-accent/40',
          !session.color && isSelected && 'bg-accent/60 border-border',
          session.color && 'pl-2.5',
          isDraggingSelf && 'opacity-40'
        )}
        style={rowStyle}
        draggable={onSessionDrop ? 'true' : undefined}
        ondragstart={onDragStart}
        ondragover={onDragOver}
        ondrop={onDrop}
        ondragend={onDragEnd}
        onclick={onClick}
        ondblclick={startEditing}
        onkeydown={onRowKey}
        role="button"
        tabindex="0"
        title={session.cwd}
      >
        {#if session.color}
          <span
            class="color-bar pointer-events-none absolute top-1 bottom-1 left-0 w-[3px] rounded-full"
            aria-hidden="true"
          ></span>
        {/if}
        {#if marker}
          <span
            class={cn(
              'pointer-events-none absolute top-1 right-0 bottom-1 w-0.5 rounded-l-full bg-primary',
              markerPulses && 'animate-pulse'
            )}
            title={marker.reason}
            aria-hidden="true"
          ></span>
        {/if}
        <KindIcon kind={session.kind} size={14} />
        <span class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="flex min-w-0 items-center gap-1.5">
            {#if editing}
              <input
                class="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-sm outline-none focus:border-ring"
                bind:this={nameInput}
                bind:value={editValue}
                onkeydown={onNameKey}
                onblur={() => void commitEditing()}
                onclick={(e) => e.stopPropagation()}
                spellcheck="false"
                autocomplete="off"
              />
            {:else}
              <span class="min-w-0 truncate text-sm leading-4 font-medium text-foreground">
                {session.name || '(unnamed)'}
              </span>
            {/if}
            {#if showAgentBadge && displayedAgentState}
              <AgentStateBadge
                state={displayedAgentState}
                summary={displayedObservedSummary}
              />
            {:else if showSpawnSpinner}
              <span
                class="inline-flex shrink-0 items-center text-muted-foreground"
                title="Starting…"
                aria-label="Starting"
              >
                <Loader2 class="size-3 animate-spin" />
              </span>
            {:else if statusPill}
              <span
                class={cn(
                  'inline-flex max-w-[92px] shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-none font-medium uppercase',
                  pillClass(statusPill.tone)
                )}
                title={statusPill.title}
                aria-label={statusPill.title}
              >
                <span class="size-1.5 shrink-0 rounded-full bg-current"></span>
                <span class="truncate">{statusPill.label}</span>
              </span>
            {/if}
          </span>
          <span class="flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-3.5 text-muted-foreground">
            <span class="min-w-0 truncate">{session.cwd}</span>
            {#if branch}
              <span class="inline-flex min-w-0 shrink-0 items-center gap-0.5">
                <span class="text-muted-foreground/55">·</span>
                <GitBranch class="size-2.5" />
                <span class="max-w-[90px] truncate">{branch}</span>
              </span>
            {/if}
          </span>
        </span>
        {#if workerCount > 0}
          <span
            class="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full border border-border bg-muted px-1 text-[11px] text-primary"
            title={`${workerCount} background worker${workerCount === 1 ? '' : 's'}`}
          >
            {workerCount}
          </span>
        {/if}
        {#if kbdIndex !== null}
          <KbdHint keys={['Ctrl', String(kbdIndex)]} class="shrink-0" />
        {/if}
        <div class="flex shrink-0 items-center gap-0.5">
          {#if session.projectId && !session.archivedAt}
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-foreground"
              onclick={archive}
              title="Archive session"
              aria-label={`Archive ${session.name || 'session'}`}
            >
              <Archive />
            </Button>
          {/if}
          {#if session.archivedAt}
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-foreground"
              onclick={restoreFromButton}
              title="Restore session"
              aria-label={`Restore ${session.name || 'session'}`}
            >
              <ArchiveRestore />
            </Button>
          {/if}
          <span class="relative flex size-7 shrink-0 items-center justify-center">
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
              onclick={removeFromButton}
              title="Delete session"
              aria-label={`Delete ${session.name || 'session'}`}
            >
              <Trash2 />
            </Button>
            <KbdHint keys={['Del']} class="pointer-events-none absolute -top-1 -right-1 z-10" />
          </span>
        </div>
      </div>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content class="w-60">
    {#if canStart}
      <ContextMenu.Item onSelect={start}>Start</ContextMenu.Item>
    {/if}
    {#if isRunning}
      <ContextMenu.Item onSelect={stop}>Stop</ContextMenu.Item>
    {/if}
    {#if status === 'running'}
      <ContextMenu.Item onSelect={restart}>Restart</ContextMenu.Item>
    {/if}
    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={() => void startEditing()}>
      <Pencil /> <span>Rename</span>
      <ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={edit}>
      <Pencil /> <span>Edit…</span>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={openCwd}>
      <FolderOpen /> <span>Open cwd</span>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={copyCmd}>
      <Copy /> <span>Copy command</span>
    </ContextMenu.Item>
    <ContextMenu.Separator />
    <div class="flex items-center gap-2 px-1 py-1">
      <div
        class={cn(
          'flex min-w-0 flex-1 items-center',
          paletteExpanded ? 'flex-wrap gap-1.5' : 'justify-between'
        )}
      >
        <button
          type="button"
          class={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-transform hover:scale-110 hover:text-foreground',
            !session.color && 'text-foreground ring-2 ring-foreground ring-offset-1 ring-offset-popover'
          )}
          onclick={(e) => {
            e.stopPropagation();
            void setColor(null);
            menuOpen = false;
          }}
          title="No color"
          aria-label="Set no color"
        >
          <CircleSlash class="size-5" />
        </button>
        {#each visibleColors as token (token)}
          <button
            type="button"
            class={cn(
              'size-5 shrink-0 rounded-full border border-border/60 transition-transform hover:scale-110',
              session.color === token && 'ring-2 ring-foreground ring-offset-1 ring-offset-popover'
            )}
            style={`background-color: ${colorVar(token)}`}
            onclick={(e) => {
              e.stopPropagation();
              void setColor(session.color === token ? null : token);
              menuOpen = false;
            }}
            title={COLOR_LABELS[token]}
            aria-label={session.color === token ? `Clear color ${COLOR_LABELS[token]}` : `Set color ${COLOR_LABELS[token]}`}
          ></button>
        {/each}
      </div>
      <button
        type="button"
        class="shrink-0 self-start rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onclick={(e) => {
          e.stopPropagation();
          paletteExpanded = !paletteExpanded;
        }}
        title={paletteExpanded ? 'Collapse palette' : 'Expand palette'}
        aria-label={paletteExpanded ? 'Collapse palette' : 'Expand palette'}
        aria-expanded={paletteExpanded}
      >
        <ChevronRight
          class={cn('size-3.5 transition-transform', paletteExpanded && 'rotate-90')}
        />
      </button>
    </div>
    <ContextMenu.Separator />
    {#if session.projectId && !session.archivedAt}
      <ContextMenu.Item onSelect={() => void archive()}>
        <Archive /> <span>Archive</span>
      </ContextMenu.Item>
    {/if}
    {#if session.archivedAt}
      <ContextMenu.Item onSelect={() => void restore()}>
        <ArchiveRestore /> <span>Restore</span>
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item variant="destructive" onSelect={remove}>
      <Trash2 /> <span>Delete</span>
      <ContextMenu.Shortcut>Del</ContextMenu.Shortcut>
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
</div>

<style>
  .session-row[data-row-color] {
    background-color: color-mix(in oklab, var(--row-color) 9%, transparent);
  }
  .session-row[data-row-color]:hover {
    background-color: color-mix(in oklab, var(--row-color) 16%, transparent);
  }
  .session-row[data-row-color][data-row-selected='true'] {
    background-color: color-mix(in oklab, var(--row-color) 24%, transparent);
    border-color: color-mix(in oklab, var(--row-color) 50%, transparent);
  }
  .color-bar {
    background-color: var(--row-color);
  }
</style>
