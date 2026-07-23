<script lang="ts">
  import { X } from '@lucide/svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import EmptyState from './EmptyState.svelte';
  import SessionToolbar from './SessionToolbar.svelte';
  import UsageLimitOverlay from './UsageLimitOverlay.svelte';
  import { displaySessionKind } from '../lib/session-agent';
  import { LazyModule } from '../lib/lazy-module.svelte';
  import { TerminalResidency } from '../lib/terminal-residency';

  type TerminalPaneComponent = typeof import('./TerminalPane.svelte').default;

  // Parsing xterm and its renderer stack used to block the shell even when
  // there was no live terminal. Preload the module before starting a PTY so
  // the output listener is ready before the first shell bytes can arrive.
  const terminalPaneModule = new LazyModule<TerminalPaneComponent>(() =>
    import('./TerminalPane.svelte').then((module) => module.default)
  );
  const terminalResidency = new TerminalResidency(4);

  let selected = $derived(sessions.selected);
  let split = $derived(sessions.activeSplit);
  let containerEl: HTMLDivElement | undefined = $state();
  let resizingSplit = $state(false);
  let selectedObserved = $derived(selected ? sessions.observationFor(selected.id) : null);
  let selectedRuntime = $derived(selected ? sessions.runtime[selected.id] : null);
  let selectedKind = $derived(selected ? displaySessionKind(selected, selectedObserved) : 'terminal');
  let dismissedHandoffKeys = $state<Record<string, true>>({});
  let handoffKey = $derived(
    selected && selectedObserved
      ? `${selected.id}:${selectedObserved.state}:${selectedObserved.lastEventAt ?? ''}`
      : null
  );
  let showAgentHandoffOverlay = $derived(
    selected !== null
      && handoffKey !== null
      && !dismissedHandoffKeys[handoffKey]
      && (selectedKind === 'claude_code' || selectedKind === 'codex')
      && (selectedObserved?.state === 'usage_limited' || selectedObserved?.state === 'failed')
  );
  let runningPanes = $derived.by(() => {
    return Object.values(sessions.runtime)
      .filter((runtime) => {
        if (!runtime.terminalId) return false;
        return runtime.status === 'running' || runtime.status === 'starting';
      })
      .map((runtime) => ({ ...runtime, terminalId: runtime.terminalId! }));
  });
  let selectedPane = $derived(
    selectedRuntime?.terminalId
      && (selectedRuntime.status === 'running' || selectedRuntime.status === 'starting')
      ? { ...selectedRuntime, terminalId: selectedRuntime.terminalId }
      : null
  );
  let visibleSessionIds = $derived.by<string[]>(() => {
    if (split) {
      const companion = split.focusedId === split.leftId ? split.rightId : split.leftId;
      return [split.focusedId, companion];
    }
    return selectedPane ? [selectedPane.sessionId] : [];
  });
  let residentSessionIds = $state<string[]>([]);
  let residentPanes = $derived(
    runningPanes.filter((pane) => residentSessionIds.includes(pane.sessionId))
  );
  let showEmpty = $derived(!selected || !selectedPane);

  $effect(() => {
    const next = terminalResidency.reconcile({
      liveSessionIds: runningPanes.map((pane) => pane.sessionId),
      visibleSessionIds
    });
    if (
      next.length !== residentSessionIds.length
      || next.some((id, index) => residentSessionIds[index] !== id)
    ) {
      residentSessionIds = next;
    }
  });

  const autoStarted = new Set<string>();

  async function startAfterTerminalPaneLoads(id: string): Promise<void> {
    const TerminalPane = await terminalPaneModule.load();
    if (!TerminalPane || autoStarted.has(id)) return;
    const currentStatus = sessions.statusFor(id);
    const currentTerminal = sessions.terminalIdFor(id);
    if (currentTerminal || currentStatus === 'starting' || currentStatus === 'running') return;
    autoStarted.add(id);
    try {
      await sessions.start(id);
    } catch (err) {
      autoStarted.delete(id);
      reportError(err);
    }
  }

  $effect(() => {
    if (!selected) return;
    const id = selected.id;
    const status = sessions.statusFor(id);
    const hasTerminal = !!sessions.terminalIdFor(id);
    if (hasTerminal) {
      // A restored PTY already has a terminal id, but its renderer module is
      // still fresh after an application reload. Load the presentation
      // without attempting to start a second process.
      void terminalPaneModule.load();
      return;
    }
    if (status === 'starting' || status === 'running') return;
    if (autoStarted.has(id)) return;
    void startAfterTerminalPaneLoads(id);
  });

  function dismissHandoffOverlay(): void {
    if (!handoffKey) return;
    dismissedHandoffKeys = { ...dismissedHandoffKeys, [handoffKey]: true };
  }

  function startSplitResize(event: PointerEvent): void {
    if (event.button !== 0 || !containerEl) return;
    event.preventDefault();
    resizingSplit = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onSplitResize);
    window.addEventListener('pointerup', stopSplitResize, { once: true });
  }

  function onSplitResize(event: PointerEvent): void {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    if (rect.width < 1) return;
    sessions.setSplitRatio((event.clientX - rect.left) / rect.width);
  }

  function stopSplitResize(): void {
    resizingSplit = false;
    window.removeEventListener('pointermove', onSplitResize);
  }
</script>

<section class="flex min-w-[220px] flex-1 flex-col bg-background">
  <SessionToolbar />
  <div class="relative min-h-0 flex-1 overflow-hidden" bind:this={containerEl}>
    {#each residentPanes as pane (pane.terminalId)}
      {@const role = split
        ? pane.sessionId === split.leftId
          ? 'left'
          : pane.sessionId === split.rightId
            ? 'right'
            : 'hidden'
        : pane.sessionId === selected?.id
          ? 'full'
          : 'hidden'}
      {@const visible = role !== 'hidden'}
      {@const focused = split ? pane.sessionId === split.focusedId : role === 'full'}
      {@const ratio = split?.ratio ?? 0.5}
      <!--
        LRU-resident hidden panes are pushed out of the viewport rather than faded out.
        xterm pauses rendering via a viewport IntersectionObserver, and an
        opacity-0 pane still intersects — so every backgrounded terminal kept
        repainting an agent TUI every frame. Translating keeps the layout box
        (display:none would zero it, and xterm's char measurement never
        recovers, leaving fit() a permanent no-op for panes that mount hidden).
      -->
      <div
        class={`group absolute inset-y-0 ${
          visible ? 'z-10' : 'z-0 pointer-events-none'
        } ${role === 'left' || role === 'right' ? '' : 'inset-x-0'} ${
          split && focused ? 'rounded-sm ring-1 ring-ring/70 ring-inset' : ''
        }`}
        style={role === 'hidden'
          ? 'transform:translateX(-200vw)'
          : role === 'left'
            ? `left:0;width:calc(${(ratio * 100).toFixed(3)}% - 2px)`
            : role === 'right'
              ? `right:0;width:calc(${((1 - ratio) * 100).toFixed(3)}% - 2px)`
              : ''}
        onfocusin={() => {
          if (split && pane.sessionId !== split.focusedId) sessions.select(pane.sessionId);
        }}
      >
        {#if terminalPaneModule.value}
          {@const TerminalPane = terminalPaneModule.value}
          <TerminalPane
            terminalId={pane.terminalId}
            sessionId={pane.sessionId}
            {visible}
            {focused}
          />
        {:else if terminalPaneModule.error}
          <div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-destructive">
            <span>Terminal renderer failed to load.</span>
            <button
              type="button"
              class="rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted"
              onclick={() => void terminalPaneModule.load()}
            >Retry</button>
          </div>
        {:else}
          <div class="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading terminal…
          </div>
        {/if}
        {#if split && visible}
          <button
            type="button"
            class="absolute top-2.5 right-3 z-20 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 group-hover:opacity-100"
            onclick={(e) => {
              e.stopPropagation();
              sessions.removeFromSplit(pane.sessionId);
            }}
            title="Remove from split"
            aria-label="Remove from split"
          >
            <X class="size-3.5" />
          </button>
        {/if}
      </div>
    {/each}
    {#if split}
      <button
        type="button"
        aria-label="Resize split panes"
        class={`absolute inset-y-0 z-20 w-1 -translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0 outline-none hover:bg-ring/30 focus-visible:bg-ring/40 ${resizingSplit ? 'bg-ring/30' : ''}`}
        style={`left:${(split.ratio * 100).toFixed(3)}%`}
        onpointerdown={startSplitResize}
      ></button>
    {/if}
    {#if selected && terminalPaneModule.error}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-xs text-destructive">
        <span>Terminal renderer failed to load: {terminalPaneModule.error.message}</span>
        <button
          type="button"
          class="rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted"
          onclick={() => void startAfterTerminalPaneLoads(selected.id)}
        >Retry</button>
      </div>
    {:else if showEmpty}
      <div class="absolute inset-0">
        <EmptyState
          session={selected}
          status={selected ? sessions.statusFor(selected.id) : 'stopped'}
        />
      </div>
    {/if}
    {#if selected && showAgentHandoffOverlay}
      <UsageLimitOverlay session={selected} onClose={dismissHandoffOverlay} />
    {/if}
  </div>
</section>
