<script lang="ts">
  import { sessions } from '../stores/sessions.svelte';
  import { modal } from '../stores/modal.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import { kindLabel } from '../lib/sessions-helpers';
  import StatusDot from './StatusDot.svelte';

  let selected = $derived(sessions.selected);
  let status = $derived(selected ? sessions.statusFor(selected.id) : 'stopped');
  let canStart = $derived(status === 'stopped' || status === 'exited' || status === 'error');
  let isRunning = $derived(status === 'running' || status === 'starting');

  async function start() {
    if (!selected) return;
    try { await sessions.start(selected.id); } catch (e) { reportError(e); }
  }
  async function stop() {
    if (!selected) return;
    try { await sessions.stop(selected.id); } catch (e) { reportError(e); }
  }
  async function restart() {
    if (!selected) return;
    try { await sessions.restart(selected.id); } catch (e) { reportError(e); }
  }
  async function remove() {
    if (!selected) return;
    if (!confirm(`Delete session "${selected.name}"?`)) return;
    try { await sessions.remove(selected.id); } catch (e) { reportError(e); }
  }
  async function openCwd() {
    if (!selected) return;
    try { await ipc.system.openPath(selected.id); } catch (e) { reportError(e); }
  }
  async function copyCmd() {
    if (!selected) return;
    try {
      const spec = await ipc.sessions.previewCommand(selected.id);
      await navigator.clipboard.writeText(spec.description);
      toasts.push('Copied command to clipboard', 'info');
    } catch (e) {
      reportError(e);
    }
  }
  function edit() {
    if (selected) modal.openEdit(selected);
  }
</script>

<div class="bar">
  {#if selected}
    <div class="meta">
      <StatusDot {status} />
      <strong>{selected.name}</strong>
      <span class="dim">· {kindLabel(selected.kind)} · {selected.runMode}</span>
    </div>
    <div class="actions">
      <button onclick={start} disabled={!canStart}>Start</button>
      <button onclick={stop} disabled={!isRunning}>Stop</button>
      <button onclick={restart} disabled={status !== 'running'}>Restart</button>
      <span class="sep"></span>
      <button onclick={edit}>Edit</button>
      <button onclick={openCwd}>Open cwd</button>
      <button onclick={copyCmd}>Copy command</button>
      <span class="sep"></span>
      <button class="danger" onclick={remove}>Delete</button>
    </div>
  {:else}
    <div class="meta dim">No session selected</div>
  {/if}
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 8px 12px;
    background: var(--bg-elev-1);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 44px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dim { color: var(--muted); font-size: 12px; }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 4px;
  }
  .danger {
    color: var(--red);
  }
  .danger:hover:not(:disabled) {
    border-color: var(--red);
  }
</style>
