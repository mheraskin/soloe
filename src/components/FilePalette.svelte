<script lang="ts">
  import { FileText, FolderOpen, Terminal } from 'lucide-svelte';
  import type { FileSearchResult } from '@shared/types/files.js';
  import { filePalette } from '../stores/file-palette.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';

  let query = $state('');
  let activeIndex = $state(0);
  let results = $state<FileSearchResult[]>([]);
  let loading = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);
  let searchSeq = 0;

  let rootPath = $derived.by(() => {
    const selected = sessions.selected;
    if (selected?.cwd) return selected.cwd;
    const selectedProject = selected?.projectId ? projects.get(selected.projectId) : null;
    return selectedProject?.path ?? '';
  });

  $effect(() => {
    if (!filePalette.open) return;
    query = '';
    activeIndex = 0;
    results = [];
    queueMicrotask(() => inputEl?.focus());
  });

  $effect(() => {
    if (!filePalette.open || !rootPath) return;
    const seq = ++searchSeq;
    loading = true;
    const timer = window.setTimeout(() => {
      ipc.files.search({ rootPath, query, limit: 80 })
        .then((next) => {
          if (seq === searchSeq) {
            results = next;
            activeIndex = 0;
          }
        })
        .catch(reportError)
        .finally(() => {
          if (seq === searchSeq) loading = false;
        });
    }, 80);
    return () => window.clearTimeout(timer);
  });

  async function openResult(result: FileSearchResult): Promise<void> {
    filePalette.close();
    await ipc.files.openInEditor({ absolutePath: result.absolutePath });
  }

  async function pasteResult(result: FileSearchResult): Promise<void> {
    const selected = sessions.selected;
    const terminalId = selected ? sessions.terminalIdFor(selected.id) : null;
    if (!terminalId) {
      await navigator.clipboard.writeText(result.path);
      filePalette.close();
      return;
    }
    filePalette.close();
    await ipc.files.pasteIntoTerminal({ terminalId, path: result.path });
  }

  function runActive(shiftKey = false): void {
    const result = results[activeIndex];
    if (!result) return;
    const action = shiftKey ? pasteResult(result) : openResult(result);
    action.catch(reportError);
  }

  function onKey(e: KeyboardEvent): void {
    if (!filePalette.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      filePalette.close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(results.length - 1, activeIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(0, activeIndex - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runActive(e.shiftKey);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if filePalette.open}
  <div class="backdrop" onclick={() => filePalette.close()} role="presentation"></div>
  <div class="palette" role="dialog" aria-modal="true" aria-label="File palette">
    <div class="input-wrap">
      <FileText size={14} />
      <input
        bind:this={inputEl}
        bind:value={query}
        type="text"
        placeholder="Find file"
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="root" title={rootPath}>
      <FolderOpen size={11} />
      <span>{rootPath || 'No active session'}</span>
    </div>
    <div class="results">
      {#if !rootPath}
        <p class="empty">No active root</p>
      {:else if loading && results.length === 0}
        <p class="empty">Searching…</p>
      {:else if results.length === 0}
        <p class="empty">No matches</p>
      {:else}
        {#each results as result, index (result.absolutePath)}
          <button
            class="row"
            class:active={index === activeIndex}
            onmousemove={() => (activeIndex = index)}
            onclick={() => {
              activeIndex = index;
              runActive(false);
            }}
            title={result.absolutePath}
          >
            <FileText size={13} />
            <span class="path">{result.path}</span>
            <span class="paste"><Terminal size={11} /> Shift Enter</span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 150;
  }
  .palette {
    position: fixed;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    width: min(720px, calc(100vw - 32px));
    max-height: min(620px, calc(100vh - 96px));
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
    z-index: 151;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .input-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
  }
  input {
    border: none;
    background: transparent;
    padding: 2px 0;
    font-size: 15px;
  }
  .root {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    color: var(--muted-2);
    font-family: var(--font-mono);
    font-size: 11px;
    border-bottom: 1px solid var(--border);
    min-width: 0;
  }
  .root span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .results {
    overflow-y: auto;
    padding: 6px;
  }
  .row {
    width: 100%;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: 1px solid transparent;
    text-align: left;
    padding: 7px 8px;
  }
  .row.active,
  .row:hover {
    background: var(--bg-elev-3);
    border-color: var(--border);
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .paste {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--muted-2);
    font-size: 10px;
  }
  .empty {
    margin: 0;
    padding: 16px;
    color: var(--muted);
  }
</style>
