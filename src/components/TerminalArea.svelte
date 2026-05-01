<script lang="ts">
  import { sessions } from '../stores/sessions.svelte';
  import TerminalPane from './TerminalPane.svelte';
  import EmptyState from './EmptyState.svelte';
  import SessionToolbar from './SessionToolbar.svelte';

  // Show panes for any session that has a live terminalId.
  let panes = $derived(
    Object.values(sessions.runtime).filter(
      (rt): rt is typeof rt & { terminalId: string } =>
        !!rt.terminalId && (rt.status === 'running' || rt.status === 'starting')
    )
  );

  let selected = $derived(sessions.selected);
  let selectedRuntime = $derived(selected ? sessions.runtime[selected.id] : null);
  let showEmpty = $derived(!selected || !selectedRuntime?.terminalId);
</script>

<section class="area">
  <SessionToolbar />
  <div class="stage">
    {#each panes as rt (rt.terminalId)}
      <div class="pane" class:active={rt.sessionId === sessions.selectedId}>
        <TerminalPane
          terminalId={rt.terminalId}
          active={rt.sessionId === sessions.selectedId}
        />
      </div>
    {/each}
    {#if showEmpty}
      <div class="pane active">
        <EmptyState
          session={selected}
          status={selected ? sessions.statusFor(selected.id) : 'stopped'}
        />
      </div>
    {/if}
  </div>
</section>

<style>
  .area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--bg);
  }
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .pane {
    position: absolute;
    inset: 0;
    visibility: hidden;
  }
  .pane.active {
    visibility: visible;
  }
</style>
