<script lang="ts">
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import EmptyState from './EmptyState.svelte';
  import SessionToolbar from './SessionToolbar.svelte';

  let selected = $derived(sessions.selected);
  let selectedRuntime = $derived(selected ? sessions.runtime[selected.id] : null);
  let selectedPane = $derived.by(() => {
    if (!selectedRuntime?.terminalId) return null;
    if (selectedRuntime.status !== 'running' && selectedRuntime.status !== 'starting') return null;
    return { ...selectedRuntime, terminalId: selectedRuntime.terminalId };
  });
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
    {#if selectedPane}
      {#key selectedPane.terminalId}
        <div class="absolute inset-0">
          <TerminalPane
            terminalId={selectedPane.terminalId}
            sessionId={selectedPane.sessionId}
            active={true}
          />
        </div>
      {/key}
    {/if}
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
