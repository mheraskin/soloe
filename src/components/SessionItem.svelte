<script lang="ts">
  import { Play, Square, RotateCw, Pencil, FolderOpen, Copy, Trash2, GitBranch } from 'lucide-svelte';
  import type { Session } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { modal } from '../stores/modal.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { confirmStore } from '../stores/confirm.svelte';
  import { ipc } from '../lib/ipc';
  import { shortCwd } from '../lib/sessions-helpers';
  import StatusDot from './StatusDot.svelte';

  let { session, branch = null }: { session: Session; branch?: string | null } = $props();

  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let editing = $state(false);
  let editValue = $state('');
  let nameInput: HTMLInputElement | null = $state(null);

  let isSelected = $derived(sessions.selectedId === session.id);
  let status = $derived(sessions.statusFor(session.id));
  let workerCount = $derived(sessions.childWorkersFor(session.id).length);
  let canStart = $derived(status === 'stopped' || status === 'exited' || status === 'error');
  let isRunning = $derived(status === 'running' || status === 'starting');

  function onClick(e: MouseEvent) {
    if (e.button !== 0) return;
    if (editing) return;
    sessions.select(session.id);
  }

  function startEditing(e: MouseEvent) {
    e.stopPropagation();
    editValue = session.name;
    editing = true;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
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
      await sessions.update(session.id, { name: next });
    } catch (err) {
      reportError(err);
    }
  }

  function onNameKey(e: KeyboardEvent) {
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
      sessions.select(session.id);
    }
  }

  function onContext(e: MouseEvent) {
    e.preventDefault();
    sessions.select(session.id);
    menuX = e.clientX;
    menuY = e.clientY;
    menuOpen = true;
  }

  function closeMenu() {
    menuOpen = false;
  }

  async function start() {
    closeMenu();
    try { await sessions.start(session.id); } catch (err) { reportError(err); }
  }
  async function stop() {
    closeMenu();
    try { await sessions.stop(session.id); } catch (err) { reportError(err); }
  }
  async function restart() {
    closeMenu();
    try { await sessions.restart(session.id); } catch (err) { reportError(err); }
  }
  function edit() {
    closeMenu();
    modal.openEdit(session);
  }
  async function remove() {
    closeMenu();
    const ok = await confirmStore.ask({
      title: 'Delete session',
      message: `Delete session "${session.name}"?`,
      confirmLabel: 'Delete',
      tone: 'danger'
    });
    if (!ok) return;
    try { await sessions.remove(session.id); } catch (err) { reportError(err); }
  }
  async function openCwd() {
    closeMenu();
    try { await ipc.system.openPath(session.id); } catch (err) { reportError(err); }
  }
  async function copyCmd() {
    closeMenu();
    try {
      const spec = await ipc.sessions.previewCommand(session.id);
      await navigator.clipboard.writeText(spec.description);
    } catch (err) {
      reportError(err);
    }
  }
</script>

<svelte:window onclick={() => menuOpen && closeMenu()} />

<div
  class="row"
  class:selected={isSelected}
  onclick={onClick}
  oncontextmenu={onContext}
  onkeydown={onRowKey}
  role="button"
  tabindex="0"
  title={session.cwd}
>
  <StatusDot {status} />
  <span class="main">
    <span class="top">
      {#if editing}
        <input
          class="name-input"
          bind:this={nameInput}
          bind:value={editValue}
          onkeydown={onNameKey}
          onblur={() => void commitEditing()}
          onclick={(e) => e.stopPropagation()}
          spellcheck="false"
          autocomplete="off"
        />
      {:else}
        <span class="name" ondblclick={startEditing} role="presentation">{session.name || '(unnamed)'}</span>
      {/if}
      {#if workerCount > 0}
        <span class="workers" title={`${workerCount} background worker${workerCount === 1 ? '' : 's'}`}>{workerCount}</span>
      {/if}
      <span class="cwd">{shortCwd(session.cwd)}</span>
    </span>
    {#if branch}
      <span class="branch">
        <GitBranch size={10} />
        <span class="branch-name">{branch}</span>
      </span>
    {/if}
  </span>
</div>

{#if menuOpen}
  <div class="menu" style="left: {menuX}px; top: {menuY}px" role="menu">
    {#if canStart}
      <button onclick={start}><Play size={12} /><span>Start</span></button>
    {/if}
    {#if isRunning}
      <button onclick={stop}><Square size={12} /><span>Stop</span></button>
    {/if}
    {#if status === 'running'}
      <button onclick={restart}><RotateCw size={12} /><span>Restart</span></button>
    {/if}
    <hr />
    <button onclick={edit}><Pencil size={12} /><span>Edit…</span></button>
    <button onclick={openCwd}><FolderOpen size={12} /><span>Open cwd</span></button>
    <button onclick={copyCmd}><Copy size={12} /><span>Copy command</span></button>
    <hr />
    <button class="danger" onclick={remove}><Trash2 size={12} /><span>Delete</span></button>
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    text-align: left;
    cursor: pointer;
    color: var(--fg);
  }
  .row:hover {
    background: var(--bg-elev-2);
    border-color: transparent;
  }
  .row.selected {
    background: var(--bg-elev-3);
    border-color: var(--border-strong);
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name-input {
    flex: 1;
    background: var(--bg-elev-2);
    color: var(--fg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 1px 4px;
    font: inherit;
    outline: none;
    min-width: 0;
  }
  .name-input:focus {
    border-color: var(--accent);
  }
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    color: var(--muted-2);
    font-size: 10px;
    font-family: var(--font-mono);
  }
  .branch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 110px;
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .cwd {
    color: var(--muted);
    font-size: 11px;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100px;
  }
  .workers {
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    background: var(--bg-elev-3);
    border: 1px solid var(--border);
    color: var(--accent);
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .menu {
    position: fixed;
    z-index: 50;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 4px;
    min-width: 160px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
  }
  .menu button {
    background: transparent;
    border: none;
    text-align: left;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .menu button:hover {
    background: var(--bg-elev-3);
  }
  .menu .danger {
    color: var(--red);
  }
  .menu hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 4px 0;
  }
</style>
