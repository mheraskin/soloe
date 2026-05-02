<script lang="ts">
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import EmptyState from './EmptyState.svelte';
  import SessionToolbar from './SessionToolbar.svelte';

  let panes = $derived(
    Object.values(sessions.runtime).filter(
      (rt): rt is typeof rt & { terminalId: string } =>
        !!rt.terminalId && (rt.status === 'running' || rt.status === 'starting')
    )
  );

  let selected = $derived(sessions.selected);
  let selectedRuntime = $derived(selected ? sessions.runtime[selected.id] : null);
  let showEmpty = $derived(!selected || !selectedRuntime?.terminalId);

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
    {#each panes as rt (rt.terminalId)}
      <div class="absolute inset-0 invisible data-[active=true]:visible" data-active={rt.sessionId === sessions.selectedId}>
        <TerminalPane
          terminalId={rt.terminalId}
          sessionId={rt.sessionId}
          active={rt.sessionId === sessions.selectedId}
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
