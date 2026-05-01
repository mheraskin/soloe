<script lang="ts">
  import {
    Play,
    Square,
    RotateCw,
    Pencil,
    FolderOpen,
    Copy,
    Trash2,
    Settings,
    Search,
    FileText
  } from 'lucide-svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { modal } from '../stores/modal.svelte';
  import { settings } from '../stores/settings.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { confirmStore } from '../stores/confirm.svelte';
  import { ipc } from '../lib/ipc';
  import { kindLabel } from '../lib/sessions-helpers';
  import StatusDot from './StatusDot.svelte';
  import GitBranchWidget from './GitBranchWidget.svelte';

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
    const ok = await confirmStore.ask({
      title: 'Delete session',
      message: `Delete session "${selected.name}"?`,
      confirmLabel: 'Delete',
      tone: 'danger'
    });
    if (!ok) return;
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
  function terminalAction(name: string) {
    window.dispatchEvent(new CustomEvent(name));
  }
  async function openInEditor() {
    if (!selected) return;
    try {
      await ipc.files.openInEditor({ absolutePath: selected.cwd });
      toasts.push('Opened cwd in editor', 'info');
    } catch (e) {
      reportError(e);
    }
  }
</script>

<div class="bar">
  {#if selected}
    <div class="meta">
      <StatusDot {status} />
      <strong>{selected.name}</strong>
      <span class="dim">· {kindLabel(selected.kind)} · {selected.runMode}</span>
      <GitBranchWidget cwd={selected.cwd} />
    </div>
    <div class="actions">
      <button onclick={start} disabled={!canStart}>
        <Play size={12} /><span>Start</span>
      </button>
      <button onclick={stop} disabled={!isRunning}>
        <Square size={12} /><span>Stop</span>
      </button>
      <button onclick={restart} disabled={status !== 'running'}>
        <RotateCw size={12} /><span>Restart</span>
      </button>
      <span class="sep"></span>
      <button onclick={edit}>
        <Pencil size={12} /><span>Edit</span>
      </button>
      <button onclick={openCwd}>
        <FolderOpen size={12} /><span>Open cwd</span>
      </button>
      <button onclick={copyCmd}>
        <Copy size={12} /><span>Copy command</span>
      </button>
      <span class="sep"></span>
      <button onclick={() => terminalAction('soloe:terminal-find')} disabled={!isRunning}>
        <Search size={12} /><span>Find</span>
      </button>
      <button onclick={() => terminalAction('soloe:terminal-save-buffer')} disabled={!isRunning}>
        <FileText size={12} /><span>Save buffer</span>
      </button>
      <button onclick={() => terminalAction('soloe:terminal-copy-buffer')} disabled={!isRunning}>
        <Copy size={12} /><span>Copy buffer</span>
      </button>
      <span class="sep"></span>
      <button onclick={() => terminalAction('soloe:terminal-copy-markdown')} disabled={!isRunning}>
        <FileText size={12} /><span>Copy Markdown</span>
      </button>
      <button onclick={openInEditor}>
        <FolderOpen size={12} /><span>Open editor</span>
      </button>
      <span class="sep"></span>
      <button class="danger" onclick={remove}>
        <Trash2 size={12} /><span>Delete</span>
      </button>
      <span class="sep"></span>
      <button onclick={() => settings.openDrawer()} title="Settings" aria-label="Settings">
        <Settings size={12} />
      </button>
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
  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
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
