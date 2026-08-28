<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { ModeWatcher, setMode } from 'mode-watcher';
  import {
    AlertTriangle,
    Bug,
    Check,
    CircleDot,
    Copy,
    Minus,
    Search,
    Trash2,
    X
  } from '@lucide/svelte';
  import type { ObservedAgentSnapshot, ObserverEvent } from '@shared/types/agents.js';
  import type {
    AgentObservedState,
    Session,
    SessionRuntimeState,
    SessionStatus
  } from '@shared/types/sessions.js';
  import type { SessionHookTraceEvent } from '@shared/types/session-debug.js';
  import type { TerminalExitEvent, TerminalStatusEvent } from '@shared/types/terminal.js';
  import { ipc, supportsBackendOperation } from '../lib/ipc';
  import { displaySessionKind } from '../lib/session-agent';
  import { sessionStatusPresentation } from '../lib/session-status-presentation';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Select from '$lib/components/ui/select';
  import { cn } from '$lib/utils';
  import AgentStateBadge from './AgentStateBadge.svelte';
  import KindIcon from './KindIcon.svelte';

  type TraceFilter = 'all' | SessionHookTraceEvent['kind'];

  interface SessionMirrorRow {
    session: Session;
    archived: boolean;
    runtimeStatus: SessionStatus;
    observedState: AgentObservedState | null;
    displayedState: AgentObservedState | null;
    displayedSummary: string | null;
    working: boolean;
    hookCount: number;
    dispatchFailureCount: number;
    lastHook: SessionHookTraceEvent | null;
    expectsHooks: boolean;
  }

  const traceLabels = {
    hook_received: 'Hook received',
    hook_rejected: 'Bridge rejected',
    hook_dispatch_started: 'Dispatch started',
    hook_dispatch_completed: 'Dispatch completed',
    hook_dispatch_failed: 'Dispatch failed'
  } satisfies Record<SessionHookTraceEvent['kind'], string>;

  const traceOptions = Object.entries(traceLabels).map(([value, label]) => ({ value, label }));

  let traceEvents = $state<SessionHookTraceEvent[]>([]);
  let activeSessions = $state<Session[]>([]);
  let archivedSessions = $state<Session[]>([]);
  let runtimes = $state<Record<string, SessionRuntimeState>>({});
  let observations = $state<Record<string, ObservedAgentSnapshot>>({});
  let observerEvents = $state<Record<string, ObserverEvent[]>>({});
  let selectedSessionId = $state<string | null>(null);
  let query = $state('');
  let traceFilter = $state<TraceFilter>('all');
  let loading = $state(true);
  let enabled = $state(false);
  let error = $state<string | null>(null);
  let copied = $state(false);

  let sessionRows = $derived.by<SessionMirrorRow[]>(() => [
    ...activeSessions.map((session) => mirrorRow(session, false)),
    ...archivedSessions.map((session) => mirrorRow(session, true))
  ]);

  let visibleTrace = $derived.by(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return traceEvents.filter((event) => {
      if (selectedSessionId && event.sessionId !== selectedSessionId) return false;
      if (traceFilter !== 'all' && event.kind !== traceFilter) return false;
      if (!normalizedQuery) return true;
      const sessionName = sessionNameFor(event.sessionId);
      return `${sessionName} ${event.sessionId ?? ''} ${event.provider} ${event.hookName ?? ''} ${event.kind} ${json(event)}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  });

  onMount(() => {
    const detachers = [
      ipc.diagnostics.onSessionHookEvent((event) => appendTrace(event)),
      ipc.observer.onSnapshot((snapshot) => {
        observations = { ...observations, [snapshot.id]: snapshot };
      }),
      ipc.observer.onEvent((event) => {
        const current = observerEvents[event.subjectId] ?? [];
        observerEvents = {
          ...observerEvents,
          [event.subjectId]: [event, ...current].slice(0, 50)
        };
      }),
      ipc.sessions.onChange((session) => upsertSession(session)),
      ipc.sessions.onDelete((sessionId) => removeSession(sessionId)),
      ipc.terminal.onStatus((event) => applyTerminalStatus(event)),
      ipc.terminal.onExit((event) => applyTerminalExit(event)),
      ipc.connection.onReconnect(() => void loadInitial()),
      ipc.settings.onChange((settings) => {
        enabled = settings.debug.sessionEvents;
        setMode(settings.appearance.theme);
      })
    ];
    void loadInitial();
    return () => {
      for (const detach of detachers) detach();
    };
  });

  async function loadInitial(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [settings, sessions, archived, running, snapshots, events, trace] = await Promise.all([
        ipc.settings.get(),
        ipc.sessions.list(),
        ipc.sessions.listArchived(),
        ipc.terminal.listRunning(),
        ipc.observer.list(),
        ipc.observer.listEvents({ limit: 2_000 }),
        ipc.diagnostics.sessionHookTrace({ limit: 5_000 })
      ]);
      enabled = settings.debug.sessionEvents;
      setMode(settings.appearance.theme);
      activeSessions = sessions;
      archivedSessions = archived;
      runtimes = Object.fromEntries(running.map((runtime) => [runtime.sessionId, runtime]));
      observations = Object.fromEntries(snapshots.map((snapshot) => [snapshot.id, snapshot]));
      observerEvents = groupObserverEvents(events);
      traceEvents = dedupeTrace([...traceEvents, ...trace]);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  function appendTrace(event: SessionHookTraceEvent): void {
    traceEvents = dedupeTrace([...traceEvents, event]);
  }

  function dedupeTrace(events: SessionHookTraceEvent[]): SessionHookTraceEvent[] {
    const seen = new SvelteSet<string>();
    return events
      .filter((event) => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      })
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 5_000);
  }

  function groupObserverEvents(events: ObserverEvent[]): Record<string, ObserverEvent[]> {
    const grouped: Record<string, ObserverEvent[]> = {};
    for (const event of events) {
      const current = grouped[event.subjectId] ?? [];
      grouped[event.subjectId] = [...current, event]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, 50);
    }
    return grouped;
  }

  function upsertSession(session: Session): void {
    activeSessions = activeSessions.filter((candidate) => candidate.id !== session.id);
    archivedSessions = archivedSessions.filter((candidate) => candidate.id !== session.id);
    if (session.archivedAt) archivedSessions = [...archivedSessions, session];
    else activeSessions = [...activeSessions, session];
  }

  function removeSession(sessionId: string): void {
    activeSessions = activeSessions.filter((session) => session.id !== sessionId);
    archivedSessions = archivedSessions.filter((session) => session.id !== sessionId);
    if (selectedSessionId === sessionId) selectedSessionId = null;
  }

  function applyTerminalStatus(event: TerminalStatusEvent): void {
    const previous = runtimes[event.sessionId];
    runtimes = {
      ...runtimes,
      [event.sessionId]: {
        sessionId: event.sessionId,
        terminalId: event.terminalId,
        status: event.status,
        ...(previous?.startedAt ? { startedAt: previous.startedAt } : {}),
        ...(event.status === 'running' && !previous?.startedAt
          ? { startedAt: new Date().toISOString() }
          : {}),
        ...(event.message ? { error: event.message } : {})
      }
    };
  }

  function applyTerminalExit(event: TerminalExitEvent): void {
    const previous = runtimes[event.sessionId];
    runtimes = {
      ...runtimes,
      [event.sessionId]: {
        sessionId: event.sessionId,
        terminalId: null,
        status: 'exited',
        ...(previous?.startedAt ? { startedAt: previous.startedAt } : {}),
        exitedAt: new Date().toISOString(),
        exitCode: event.exitCode,
        signal: event.signal
      }
    };
  }

  function mirrorRow(session: Session, archived: boolean): SessionMirrorRow {
    const runtime = runtimes[session.id];
    const runtimeStatus = runtime?.status ?? 'stopped';
    const observed = observations[session.id] ?? null;
    const latestEvent = observerEvents[session.id]?.[0] ?? null;
    const observedSummary = latestEvent?.state === observed?.state
      ? latestEvent?.summary ?? null
      : observed?.resultSummary ?? observed?.promptSummary ?? null;
    const presentation = sessionStatusPresentation({
      session,
      status: runtimeStatus,
      observed,
      observedSummary,
      hasRuntime: runtime !== undefined,
      hasNotificationMarker: false
    });
    const sessionTrace = traceEvents.filter((event) => event.sessionId === session.id);
    const received = sessionTrace.filter((event) => event.kind === 'hook_received');
    return {
      session,
      archived,
      runtimeStatus,
      observedState: observed?.state ?? null,
      displayedState: presentation.agentState,
      displayedSummary: presentation.agentSummary,
      working: presentation.working,
      hookCount: received.length,
      dispatchFailureCount: sessionTrace.filter((event) => event.kind === 'hook_dispatch_failed').length,
      lastHook: received[0] ?? null,
      expectsHooks: session.launch.type === 'agent'
    };
  }

  function sessionNameFor(sessionId: string | null): string {
    if (!sessionId) return 'Unattributed hook';
    return [...activeSessions, ...archivedSessions].find((session) => session.id === sessionId)?.name
      ?? sessionId;
  }

  function traceSummary(event: SessionHookTraceEvent): string {
    if (event.kind === 'hook_rejected') return event.reason.replaceAll('_', ' ');
    if (event.kind === 'hook_dispatch_failed') return event.error;
    return event.hookName ?? 'unnamed provider event';
  }

  function traceTone(event: SessionHookTraceEvent): string {
    if (event.kind === 'hook_rejected' || event.kind === 'hook_dispatch_failed') {
      return 'border-destructive/40 text-destructive';
    }
    if (event.kind === 'hook_received') return 'border-primary/40 text-primary';
    return 'border-border text-muted-foreground';
  }

  function formatTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          fractionalSecondDigits: 3
        }).format(date);
  }

  function json(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  async function copyVisible(): Promise<void> {
    await navigator.clipboard.writeText(json(visibleTrace));
    copied = true;
    window.setTimeout(() => {
      copied = false;
    }, 1_500);
  }

  async function clearTrace(): Promise<void> {
    await ipc.diagnostics.clearSessionHookTrace();
    traceEvents = [];
  }

  function setTraceFilter(value: string): void {
    switch (value) {
      case 'all':
      case 'hook_received':
      case 'hook_rejected':
      case 'hook_dispatch_started':
      case 'hook_dispatch_completed':
      case 'hook_dispatch_failed':
        traceFilter = value;
    }
  }

  function minimize(): void {
    if (supportsBackendOperation('window', 'minimize')) void ipc.window.minimize();
  }

  function close(): void {
    if (supportsBackendOperation('window', 'close')) {
      void ipc.window.close();
      return;
    }
    window.close();
  }
</script>

<ModeWatcher defaultMode="system" />

<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
  <header
    class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3 select-none"
    style="-webkit-app-region: drag"
  >
    <Bug class="size-3.5 text-primary" aria-hidden="true" />
    <span class="text-xs font-medium">Raw Session hook trace</span>
    <span class="text-[10px] text-muted-foreground">{traceEvents.length} records</span>
    <div class="flex-1"></div>
    <div class="flex items-center" style="-webkit-app-region: no-drag">
      {#if supportsBackendOperation('window', 'minimize')}
        <button
          type="button"
          class="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onclick={minimize}
          aria-label="Minimize"
        >
          <Minus class="size-3.5" />
        </button>
      {/if}
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
        onclick={close}
        aria-label="Close"
      >
        <X class="size-3.5" />
      </button>
    </div>
  </header>

  {#if !enabled}
    <div class="border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
      Raw hook capture is off. Enable Session events under Settings, then start or resume the
      Session you want to inspect.
    </div>
  {/if}

  <div class="flex min-h-0 flex-1">
    <aside class="flex w-80 shrink-0 flex-col border-r border-border bg-card/30">
      <div class="border-b border-border px-3 py-2">
        <div class="text-xs font-medium">Sidebar mirror</div>
        <div class="mt-0.5 text-[10px] text-muted-foreground">
          Rendered state beside direct provider hook counts
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <button
          type="button"
          class={cn(
            'mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs',
            selectedSessionId === null ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
          )}
          onclick={() => (selectedSessionId = null)}
        >
          <CircleDot class="size-3.5" />
          <span class="font-medium">All Sessions</span>
          <span class="ml-auto font-mono text-[10px]">{sessionRows.length}</span>
        </button>

        {#each sessionRows as row (row.session.id)}
          <button
            type="button"
            class={cn(
              'mb-1 w-full rounded-md border px-2 py-2 text-left',
              selectedSessionId === row.session.id
                ? 'border-primary/40 bg-primary/8'
                : 'border-transparent hover:bg-muted/60',
              row.archived && 'opacity-60'
            )}
            onclick={() => (selectedSessionId = row.session.id)}
          >
            <div class="flex items-center gap-2">
              <KindIcon kind={displaySessionKind(row.session, observations[row.session.id] ?? null)} size={13} />
              <span class="min-w-0 flex-1 truncate text-xs font-medium">{row.session.name}</span>
              {#if row.displayedState}
                <AgentStateBadge
                  state={row.displayedState}
                  summary={row.displayedSummary}
                  class="max-w-24"
                />
              {:else if row.working}
                <span class="text-[10px] font-medium text-warning">loading</span>
              {:else}
                <span class="font-mono text-[9px] text-muted-foreground">{row.runtimeStatus}</span>
              {/if}
            </div>
            <div class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[9px] text-muted-foreground">
              <span>observer</span>
              <span class="truncate">{row.observedState ?? 'none'}</span>
              <span>runtime</span>
              <span>{row.runtimeStatus}</span>
              <span>raw hooks</span>
              <span class={cn(
                row.expectsHooks && row.runtimeStatus === 'running' && row.hookCount === 0
                  ? 'text-warning'
                  : 'text-foreground/80'
              )}>
                {row.hookCount}{row.lastHook?.hookName ? ` · ${row.lastHook.hookName}` : ''}
              </span>
            </div>
            {#if row.dispatchFailureCount > 0}
              <div class="mt-1.5 flex items-center gap-1 text-[10px] text-destructive">
                <AlertTriangle class="size-3" />
                {row.dispatchFailureCount} dispatch failure{row.dispatchFailureCount === 1 ? '' : 's'}
              </div>
            {:else if row.expectsHooks && row.runtimeStatus === 'running' && row.hookCount === 0}
              <div class="mt-1.5 flex items-center gap-1 text-[10px] text-warning">
                <AlertTriangle class="size-3" />
                No provider hooks received
              </div>
            {/if}
          </button>
        {/each}
      </div>
    </aside>

    <section class="flex min-w-0 flex-1 flex-col">
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2">
        <div class="relative min-w-56 flex-1">
          <Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            bind:value={query}
            class="h-8 pl-7 text-xs"
            placeholder="Filter provider, hook name, request, or raw body…"
          />
        </div>
        <Select.Root type="single" value={traceFilter} onValueChange={setTraceFilter}>
          <Select.Trigger class="h-8 w-44 text-xs">
            {traceFilter === 'all' ? 'All trace stages' : traceLabels[traceFilter]}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="all" label="All trace stages">All trace stages</Select.Item>
            {#each traceOptions as option (option.value)}
              <Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <Button variant="outline" size="sm" onclick={() => void copyVisible()} disabled={visibleTrace.length === 0}>
          {#if copied}<Check class="size-3" />{:else}<Copy class="size-3" />{/if}
          {copied ? 'Copied' : 'Copy visible'}
        </Button>
        <Button variant="outline" size="sm" onclick={() => void clearTrace()} disabled={traceEvents.length === 0}>
          <Trash2 class="size-3" />
          Clear
        </Button>
      </div>

      <div class="border-b border-border bg-muted/20 px-3 py-1.5 text-[10px] text-muted-foreground">
        Hook received is recorded at bridge entry, before Observer or sidebar state reduction.
        Dispatch stages show whether Soloe processed that exact request.
      </div>

      <main class="min-h-0 flex-1 overflow-y-auto p-2">
        {#if loading && traceEvents.length === 0}
          <div class="px-3 py-10 text-center text-xs text-muted-foreground">Loading raw hook trace…</div>
        {:else if error}
          <div class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}</div>
        {:else if visibleTrace.length === 0}
          <div class="px-3 py-10 text-center text-xs text-muted-foreground">
            No matching provider hook records
          </div>
        {:else}
          <div class="flex flex-col gap-1.5">
            {#each visibleTrace as event (event.id)}
              <details class="group rounded-md border border-border bg-card/60 open:bg-card">
                <summary class="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <span class="w-[92px] shrink-0 font-mono text-[10px] text-muted-foreground">
                    {formatTimestamp(event.timestamp)}
                  </span>
                  <span class={cn(
                    'w-28 shrink-0 rounded border px-1.5 py-0.5 text-center text-[9px] font-medium tracking-wide uppercase',
                    traceTone(event)
                  )}>
                    {traceLabels[event.kind]}
                  </span>
                  <span class="min-w-0 flex-1 truncate font-medium" title={event.sessionId ?? 'Unattributed'}>
                    {sessionNameFor(event.sessionId)}
                  </span>
                  <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                    {event.provider}
                  </span>
                  <span class="min-w-0 max-w-[38%] truncate text-muted-foreground">
                    {traceSummary(event)}
                  </span>
                </summary>
                <div class="border-t border-border bg-muted/20 p-2">
                  <div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    <span>session: {event.sessionId ?? 'missing'}</span>
                    <span>request: {event.requestId}</span>
                    <span>integration: {event.integrationVersion ?? 'unknown'}</span>
                    <span>time: {event.timestamp}</span>
                  </div>
                  {#if event.kind === 'hook_received'}
                    <div class="mb-1 text-[10px] font-medium text-muted-foreground">Provider body, verbatim</div>
                    <pre class="max-h-[24rem] overflow-auto whitespace-pre-wrap break-all rounded border border-primary/20 bg-background p-2 font-mono text-[10px] leading-4 text-foreground">{event.rawBody || '(empty body)'}</pre>
                    {#if !event.dispatchable}
                      <div class="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-[10px] text-warning-foreground">
                        The provider body was valid JSON but not an object. Soloe dispatched an empty object.
                      </div>
                    {/if}
                  {:else}
                    <pre class="max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 font-mono text-[10px] leading-4 text-foreground">{json(event)}</pre>
                  {/if}
                </div>
              </details>
            {/each}
          </div>
        {/if}
      </main>
    </section>
  </div>
</div>
