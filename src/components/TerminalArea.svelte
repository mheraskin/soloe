<script lang="ts">
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import EmptyState from './EmptyState.svelte';
  import SessionToolbar from './SessionToolbar.svelte';

  let selected = $derived(sessions.selected);
  let selectedRuntime = $derived(selected ? sessions.runtime[selected.id] : null);
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
  let showEmpty = $derived(!selected || !selectedPane);

  const autoStarted = new Set<string>();

  $effect(() => {
    if (!selected) return;
    const id = selected.id;
    const status = sessions.statusFor(id);
    const hasTerminal = !!sessions.terminalIdFor(id);
    if (hasTerminal) return;
    if (status === 'starting' || status === 'running') return;
    if (autoStarted.has(id)) return;
    autoStarted.add(id);
    void sessions.start(id).catch((err) => {
      autoStarted.delete(id);
      reportError(err);
    });
  });
</script>

<section class="flex min-w-0 flex-1 flex-col bg-background">
  <SessionToolbar />
  <div class="relative min-h-0 flex-1">
    {#each runningPanes as pane (pane.terminalId)}
      {@const active = pane.sessionId === selected?.id}
      <div class={`absolute inset-0 ${active ? 'z-10 opacity-100' : 'z-0 pointer-events-none opacity-0'}`}>
        <TerminalPane
          terminalId={pane.terminalId}
          sessionId={pane.sessionId}
          {active}
        />
      </div>
    {/each}
    {#if showEmpty}
      <div class="absolute inset-0">
        <EmptyState
          session={selected}
          status={selected ? sessions.statusFor(selected.id) : 'stopped'}
        />
      </div>
    {/if}
  </div>
</section>
