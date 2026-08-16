<script lang="ts">
  import { tick } from 'svelte';
  import {
    Loader2,
    Trash2,
    GitBranch,
    Monitor
  } from '@lucide/svelte';
  import type {
    Session,
    SessionId
  } from '@shared/types/sessions.js';
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { agentNotifications } from '../stores/agent-notifications.svelte';
  import { nav } from '../stores/nav.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { confirmDeleteSession } from '../lib/session-delete-confirmation';
  import { displaySessionKind } from '../lib/session-agent';
  import {
    displayedAgentState as resolveDisplayedAgentState,
    displayedAgentSummary
  } from '../lib/session-display-state';
  import { cn } from '$lib/utils';
  import { Button } from '$lib/components/ui/button';
  import { dnd, DND_MIME, dropPositionFromEvent, type DropPosition } from '../stores/dnd.svelte';
  import KindIcon from './KindIcon.svelte';
  import KbdHint from './KbdHint.svelte';
  import AgentStateBadge from './AgentStateBadge.svelte';
  import SessionContextMenu from './SessionContextMenu.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';

  type StatusTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

  interface StatusPill {
    label: string;
    title: string;
    tone: StatusTone;
  }

  let {
    session,
    branch = null,
    projection = null,
    showDevice = false,
    onSessionDrop = null
  }: {
    session: Session;
    branch?: string | null;
    projection?: MultiDeviceSessionView | null;
    showDevice?: boolean;
    onSessionDrop?:
      | ((args: { draggedId: SessionId; targetId: SessionId; position: DropPosition }) => void)
      | null;
  } = $props();

  let editing = $state(false);
  let editValue = $state('');
  let nameInput: HTMLInputElement | null = $state(null);

  let managedLocally = $derived(
    !projection || deviceSessions.device(projection.ref.deviceId)?.local === true
  );
  let isSelected = $derived(
    projection ? deviceSessions.isSelected(projection) : sessions.selectedId === session.id
  );
  let status = $derived(projection?.runtime?.status ?? sessions.statusFor(session.id));
  let observed = $derived(managedLocally ? sessions.observationFor(session.id) : null);
  let displayKind = $derived(displaySessionKind(session, observed));
  let latestEvent = $derived(managedLocally ? sessions.eventsFor(session.id)[0] ?? null : null);
  let observedSummary = $derived(
    latestEvent?.state === observed?.state
      ? latestEvent?.summary ?? null
      : observed?.resultSummary ?? observed?.promptSummary ?? null
  );
  let marker = $derived(managedLocally ? agentNotifications.markerFor(session.id) : null);
  let markerPulses = $derived(managedLocally && agentNotifications.pulsingSessionId === session.id);
  let workerCount = $derived(managedLocally ? sessions.childWorkersFor(session.id).length : 0);
  let kbdIndex = $derived(managedLocally ? nav.sessionIndexHints[session.id] ?? null : null);
  // hasRuntime distinguishes "user has launched this at least once in this app
  // session" from the cold pre-spawn state, where we want neither pill nor
  // spinner.
  let hasRuntime = $derived(
    projection ? projection.runtime !== null : sessions.runtime[session.id] !== undefined
  );
  let isAgent = $derived(displayKind === 'claude_code' || displayKind === 'codex');
  let displayedAgentState = $derived(
    resolveDisplayedAgentState({
      observed,
      status,
      hasRuntime,
      hasNotificationMarker: marker !== null
    })
  );
  let displayedObservedSummary = $derived(
    displayedAgentSummary(observed, displayedAgentState, observedSummary)
  );
  let showSpawnSpinner = $derived(hasRuntime && status === 'starting');
  let showAgentBadge = $derived(isAgent && displayedAgentState !== null);
  let statusPill = $derived(buildStatusPill());
  let remoteLifecycle = $derived(
    projection && !managedLocally
      ? {
          start: () => deviceSessions.openSession(projection!.key),
          stop: () => deviceSessions.stopSession(projection!.key),
          restart: () => deviceSessions.restartSession(projection!.key)
        }
      : null
  );
  let remoteMutations = $derived(
    projection && !managedLocally
      ? {
          update: (patch: import('@shared/types/sessions.js').SessionUpdate) =>
            deviceSessions.updateSession(projection!.key, patch),
          remove: () => deviceSessions.deleteSession(projection!.key),
          previewCommand: () => deviceSessions.previewCommand(projection!.key)
        }
      : null
  );

  function onClick(e: MouseEvent) {
    if (e.button !== 0 || editing) return;
    if (projection) {
      if (isSelected) {
        if (managedLocally) sessions.select(null);
        else deviceSessions.clearSelectedSession();
      } else {
        void deviceSessions.openSession(projection.key).catch(reportError);
      }
      return;
    }
    if (isSelected) sessions.select(null); else sessions.select(session.id);
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
      const patch = { name: next, autoNamed: false };
      if (projection && !managedLocally) await deviceSessions.updateSession(projection.key, patch);
      else await sessions.update(session.id, patch);
    } catch (err) {
      reportError(err);
    }
  }

  function onNameKey(e: KeyboardEvent) {
    e.stopPropagation();
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
      onClick(new MouseEvent('click'));
    } else if (e.key === 'F2') {
      e.preventDefault();
      void startEditing();
    }
  }

  async function remove() {
    const ok = await confirmDeleteSession(session);
    if (!ok) return;
    try {
      if (projection && !managedLocally) await deviceSessions.deleteSession(projection.key);
      else await sessions.remove(session.id);
    } catch (err) { reportError(err); }
  }
  function removeFromButton(e: Event) {
    e.stopPropagation();
    void remove();
  }

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
  let dragId = $derived(projection?.key ?? session.id);
  let dropPosition = $derived.by<DropPosition | null>(() => {
    if (!onSessionDrop) return null;
    const t = dnd.target;
    if (!t || t.kind !== 'session' || t.id !== dragId) return null;
    if (dnd.drag?.id === dragId) return null;
    return t.position;
  });
  let isDraggingSelf = $derived(dnd.drag?.kind === 'session' && dnd.drag.id === dragId);

  function onDragStart(e: DragEvent) {
    if (!onSessionDrop || !e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DND_MIME.session, dragId);
    dnd.begin({
      kind: 'session',
      id: dragId,
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
      || dnd.target.id !== dragId
      || dnd.target.position !== position
    ) {
      dnd.setTarget({ kind: 'session', id: dragId, position });
    }
  }

  function onDrop(e: DragEvent) {
    if (!onSessionDrop) return;
    if (dnd.drag?.kind !== 'session') return;
    const draggedId = dnd.drag.id;
    if (draggedId === dragId) return;
    e.preventDefault();
    const position = dnd.target?.kind === 'session' && dnd.target.id === dragId
      ? dnd.target.position
      : 'after';
    onSessionDrop({ draggedId, targetId: dragId, position });
    dnd.end();
  }

  function onDragEnd() {
    dnd.end();
  }

  let rowStyle = $derived(
    session.color ? `--row-color: var(--session-${session.color});` : undefined
  );
</script>

<div class="relative">
  {#if dropPosition === 'before'}
    <div class="pointer-events-none absolute -top-px right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
  {/if}
  {#if dropPosition === 'after'}
    <div class="pointer-events-none absolute -bottom-px right-1 left-1 z-10 h-0.5 rounded-full bg-primary"></div>
  {/if}
  <SessionContextMenu
    {session}
    statusOverride={projection ? status : null}
    lifecycle={remoteLifecycle}
    mutations={remoteMutations}
    onRename={() => void startEditing()}
  >
    {#snippet trigger({ props })}
      <div
        {...props}
        bind:this={rowEl}
        data-session-id={projection?.key ?? session.id}
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
        title={projection ? `${session.cwd} · ${projection.deviceName}` : session.cwd}
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
        {#if kbdIndex !== null}
          <span
            class="pointer-events-none absolute top-0.5 left-0.5 font-mono text-[9px] leading-none text-muted-foreground/55"
            aria-hidden="true"
          >
            {kbdIndex}
          </span>
        {/if}
        <KindIcon kind={displayKind} size={14} />
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
            {#if projection && showDevice}
              <span class="inline-flex min-w-0 shrink-0 items-center gap-0.5">
                <span class="text-muted-foreground/55">·</span>
                <Monitor class="size-2.5" />
                <span class="max-w-[90px] truncate">{projection.deviceName}</span>
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
            <KbdHint keys={['Ctrl', 'Del']} class="pointer-events-none absolute -top-1 -right-1 z-10" />
          </span>
        </div>
      </div>
    {/snippet}
  </SessionContextMenu>
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
