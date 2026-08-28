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
  import { rightRail } from '../stores/right-rail.svelte';
  import { agentNotifications } from '../stores/agent-notifications.svelte';
  import { nav } from '../stores/nav.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { confirmDeleteSession } from '../lib/session-delete-confirmation';
  import { displaySessionKind } from '../lib/session-agent';
  import { sessionStatusPresentation } from '../lib/session-status-presentation';
  import { deviceSessionStatus } from '../lib/device-terminal-presentation';
  import type { AgentStateTone } from '../lib/agent-state-presentation';
  import { displayPath } from '../lib/display-path';
  import { shortRelativeTime, fullTimestamp } from '../lib/relative-time';
  import { clock } from '../stores/clock.svelte';
  import { cn } from '$lib/utils';
  import { Button } from '$lib/components/ui/button';
  import { dnd, DND_MIME, dropPositionFromEvent, type DropPosition } from '../stores/dnd.svelte';
  import KindIcon from './KindIcon.svelte';
  import KbdHint from './KbdHint.svelte';
  import AgentStateBadge from './AgentStateBadge.svelte';
  import SessionContextMenu from './SessionContextMenu.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';

  type DotTone = 'live' | 'starting' | 'unknown' | 'attention' | 'danger';

  interface StatusPill {
    label: string;
    title: string;
    tone: AgentStateTone;
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

  $effect(() => clock.subscribe());

  let editing = $state(false);
  let editValue = $state('');
  let nameInput: HTMLInputElement | null = $state(null);

  let ownerDevice = $derived(
    projection ? deviceSessions.device(projection.ref.deviceId) : null
  );
  let managedLocally = $derived(!projection || ownerDevice?.local === true);
  let offline = $derived(
    Boolean(projection && (!projection.available || ownerDevice?.available !== true))
  );
  let isSelected = $derived(
    projection ? deviceSessions.isSelected(projection) : sessions.selectedId === session.id
  );
  let status = $derived(
    projection ? deviceSessionStatus(projection) : sessions.statusFor(session.id)
  );
  let pendingOperation = $derived(projection ? deviceSessions.pendingOperation(projection.key) : null);
  let observed = $derived(
    managedLocally ? sessions.observationFor(session.id) : projection?.observation ?? null
  );
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
  let isAgent = $derived(
    displayKind === 'claude_code'
      || displayKind === 'codex'
      || displayKind === 'cursor'
      || displayKind === 'opencode'
      || displayKind === 'grok_build'
  );
  let statusPresentation = $derived(
    sessionStatusPresentation({
      session,
      observed,
      status,
      observedSummary,
      hasRuntime,
      hasNotificationMarker: marker !== null
    })
  );
  let displayedAgentState = $derived(statusPresentation.agentState);
  let displayedObservedSummary = $derived(statusPresentation.agentSummary);
  let showSpawnSpinner = $derived(
    !offline
    && (
      status === 'starting'
      || pendingOperation === 'starting'
      || pendingOperation === 'stopping'
      || pendingOperation === 'restarting'
      || pendingOperation === 'updating'
      || pendingOperation === 'deleting'
    )
  );
  let showAgentBadge = $derived(
    isAgent && displayedAgentState !== null && pendingOperation === null && !offline
  );
  let pendingLabel = $derived(
    pendingOperation === 'stopping'
      ? 'Stopping'
      : pendingOperation === 'restarting'
        ? 'Restarting'
        : pendingOperation === 'updating'
          ? 'Saving'
          : pendingOperation === 'deleting'
            ? 'Deleting'
            : 'Starting'
  );
  let statusPill = $derived(buildStatusPill());
  // The dot answers "is this alive?" — the same question the Session tab
  // strip's dot answers, in the same colours. A dot means we have a reading:
  // green running, amber starting, red crashed. No dot means there is no
  // process, which covers both `stopped` and `exited` — a distinction that
  // matters to the launcher, not to the eye, and one the label already draws
  // when there's an exit code to show. A dimmed dot means we can't get a
  // reading at all, which is what offline is. What the agent is *doing* stays
  // the label's job, so the two never encode the same axis twice. The single
  // override is a Session that wants a human, which outranks liveness because
  // that's the thing you scan the list for.
  let dotTone = $derived.by<DotTone | null>(() => {
    if (offline) return 'unknown';
    if (pendingOperation !== null || showSpawnSpinner) return 'starting';
    if (
      displayedAgentState === 'waiting_for_approval'
      || displayedAgentState === 'waiting_for_input'
      || displayedAgentState === 'usage_limited'
    ) {
      return 'attention';
    }
    if (status === 'error') return 'danger';
    if (status === 'starting') return 'starting';
    if (status === 'running') return 'live';
    return null;
  });
  let dotTitle = $derived(
    offline
      ? 'Offline · read-only'
      : displayedAgentState
        ? `${status} · ${displayedAgentState}`
        : status
  );
  let relativeLabel = $derived(shortRelativeTime(session.lastUsedAt, clock.now));
  let lastUsedTitle = $derived(fullTimestamp(session.lastUsedAt));
  // Every row states its own working directory and branch, group or not. The
  // Device remains a separate, fixed-position label at the end of the row.
  let metaParts = $derived.by<{ icon: 'path' | 'branch'; text: string }[]>(() => {
    const parts: { icon: 'path' | 'branch'; text: string }[] = [];
    // A Session without a cwd contributes nothing rather than an empty part,
    // which would still print its separator and leave the line opening on a
    // stray dot.
    const path = displayPath(session.cwd);
    if (path) parts.push({ icon: 'path', text: path });
    if (branch) parts.push({ icon: 'branch', text: branch });
    return parts;
  });
  let remoteLifecycle = $derived(
    projection && !managedLocally && !offline
      ? {
          start: () => deviceSessions.openSession(projection!.key),
          stop: () => deviceSessions.stopSession(projection!.key),
          restart: () => deviceSessions.restartSession(projection!.key)
        }
      : null
  );
  let remoteMutations = $derived(
    projection && !managedLocally && !offline
      ? {
          update: (patch: import('@shared/types/sessions.js').SessionUpdate) =>
            deviceSessions.updateSession(projection!.key, patch),
          remove: () => deviceSessions.deleteSession(projection!.key),
          previewCommand: () => deviceSessions.previewCommand(projection!.key)
        }
      : null
  );

  function onClick(e: MouseEvent) {
    if (e.button !== 0 || editing || pendingOperation) return;
    rightRail.fullscreen = false;
    if (projection) {
      if (offline) {
        if (isSelected) {
          if (managedLocally) sessions.select(null);
          else deviceSessions.clearSelectedSession();
        } else {
          deviceSessions.selectSession(projection.key);
        }
        return;
      }
      if (status === 'stopped' || status === 'exited' || status === 'error') {
        if (managedLocally) {
          deviceSessions.selectSession(projection.key);
          void sessions.start(session.id).catch(reportError);
        } else {
          void deviceSessions.openSession(projection.key).catch(reportError);
        }
        return;
      }
      if (isSelected) {
        if (managedLocally) sessions.select(null);
        else deviceSessions.clearSelectedSession();
      } else {
        if (managedLocally) deviceSessions.selectSession(projection.key);
        else void deviceSessions.openSession(projection.key).catch(reportError);
      }
      return;
    }
    if (status === 'stopped' || status === 'exited' || status === 'error') {
      sessions.select(session.id);
      void sessions.start(session.id).catch(reportError);
      return;
    }
    if (isSelected) sessions.select(null); else sessions.select(session.id);
  }

  async function startEditing(e?: Event) {
    e?.stopPropagation();
    if (editing || pendingOperation || offline) return;
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
    if (offline) {
      cancelEditing();
      return;
    }
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
    if (pendingOperation || offline) return;
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
    if (offline) {
      return {
        label: 'offline',
        title: 'Offline · read-only',
        tone: 'idle'
      };
    }
    if (!isAgent) return null;
    if (status === 'stopped') return null;
    const showRemoteLifecycle = projection !== null && !managedLocally;
    if (!showRemoteLifecycle && (!hasRuntime || (status !== 'exited' && status !== 'error'))) {
      return null;
    }
    return {
      label: status,
      title: status,
      tone: status === 'error' ? 'danger' : status === 'running' ? 'active' : 'idle'
    };
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
    if (!onSessionDrop || !e.dataTransfer || offline) return;
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
    if (!onSessionDrop || !rowEl || offline) return;
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
    if (!onSessionDrop || offline) return;
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
    disabled={pendingOperation !== null || offline}
    onRename={() => void startEditing()}
  >
    {#snippet trigger({ props })}
      <div
        {...props}
        bind:this={rowEl}
        data-session-id={projection?.key ?? session.id}
        data-row-color={session.color ?? undefined}
        aria-busy={pendingOperation ? 'true' : undefined}
        aria-disabled={pendingOperation ? 'true' : undefined}
        data-sb-active={isSelected ? 'true' : undefined}
        class={cn('sb-row sb-group cursor-pointer', isDraggingSelf && 'opacity-40')}
        style={rowStyle}
        draggable={onSessionDrop && !pendingOperation && !offline ? 'true' : undefined}
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
          <span class="sb-rail" aria-hidden="true"></span>
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
        <span class="sb-icon">
          <KindIcon kind={displayKind} size={14} />
          {#if dotTone}
            <span class="sb-dot" data-tone={dotTone} title={dotTitle} aria-hidden="true"></span>
          {/if}
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="flex min-w-0 items-center gap-2">
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
              <span
                class="sb-title"
                data-lead="true"
                data-strong={isSelected ? 'true' : undefined}
              >
                {session.name || '(unnamed)'}
              </span>
            {/if}
            {#if kbdIndex !== null}
              <KbdHint keys={['Ctrl', String(kbdIndex)]} class="shrink-0" />
            {/if}
            <span
              class="relative flex min-h-5 shrink-0 items-center justify-end"
              data-session-primary-action
            >
              <span class="sb-rest-indicator flex min-w-0 justify-end" data-session-rest-indicator>
                {#if showAgentBadge && displayedAgentState}
                  <AgentStateBadge
                    state={displayedAgentState}
                    summary={displayedObservedSummary}
                    class="shrink-0"
                  />
                {:else if showSpawnSpinner}
                  <span
                    class="sb-state shrink-0"
                    data-tone="active"
                    title={`${pendingLabel}…`}
                    aria-label={pendingLabel}
                  >
                    <Loader2 class="size-2.5 shrink-0 animate-spin" />
                  </span>
                {:else if statusPill}
                  <span
                    class="sb-state shrink-0"
                    data-tone={statusPill.tone}
                    title={statusPill.title}
                    aria-label={statusPill.title}
                  >
                    <span class="truncate">{statusPill.label}</span>
                  </span>
                {:else if relativeLabel}
                  <span class="sb-meta sb-meta-faint shrink-0 tabular-nums" title={lastUsedTitle}>
                    {relativeLabel}
                  </span>
                {/if}
              </span>
              <span
                class="sb-reveal absolute right-0 -my-0.5 flex size-5 items-center justify-center"
                data-session-hover-action="delete"
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  class="size-5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onclick={removeFromButton}
                  disabled={pendingOperation !== null || offline}
                  title={offline
                    ? 'Unavailable while Device is offline'
                    : pendingOperation === 'deleting' ? 'Deleting session…' : 'Delete session'}
                  aria-label={pendingOperation === 'deleting'
                    ? `Deleting ${session.name || 'session'}`
                    : `Delete ${session.name || 'session'}`}
                >
                  {#if pendingOperation === 'deleting'}
                    <Loader2 class="size-3 animate-spin" />
                  {:else}
                    <Trash2 class="size-3" />
                  {/if}
                </Button>
                <KbdHint keys={['Ctrl', 'Del']} class="pointer-events-none absolute -top-1 -right-1 z-10" />
              </span>
            </span>
          </span>
          <span class="flex min-w-0 items-center gap-2">
            {#if metaParts.length > 0}
              <span
                class="sb-meta flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap"
                data-session-metadata="compact"
              >
                {#each metaParts as part (part.icon)}
                  <span
                    data-session-meta={part.icon}
                    title={part.text}
                    class={cn(
                      'inline-flex min-w-0 items-center gap-1 overflow-hidden',
                      part.icon === 'path'
                        ? 'flex-1'
                        : 'max-w-40 shrink'
                    )}
                  >
                    {#if part.icon === 'branch'}
                      <GitBranch class="size-2.5 shrink-0" />
                    {/if}
                    <span class="truncate {part.icon === 'path' ? 'font-mono' : ''}">{part.text}</span>
                  </span>
                {/each}
              </span>
            {:else}
              <span class="min-w-0 flex-1"></span>
            {/if}
            {#if workerCount > 0}
              <span
                class="sb-meta shrink-0 tabular-nums"
                title={`${workerCount} background worker${workerCount === 1 ? '' : 's'}`}
              >
                {workerCount}w
              </span>
            {/if}
            {#if projection && showDevice}
              <span
                class="sb-meta ml-auto inline-flex max-w-24 shrink-0 items-center gap-1"
                data-session-device="corner"
                title={projection.deviceName}
              >
                <Monitor class="size-2.5 shrink-0" />
                <span class="truncate">{projection.deviceName}</span>
              </span>
            {/if}
          </span>
        </span>
      </div>
    {/snippet}
  </SessionContextMenu>
</div>
