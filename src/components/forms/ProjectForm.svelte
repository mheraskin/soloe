<script lang="ts">
  import { Folder, FolderOpen } from 'lucide-svelte';
  import type { ProjectPathSuggestion } from '@shared/types/projects.js';
  import type { RunMode } from '@shared/types/sessions.js';
  import { projectModal } from '../../stores/project-modal.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { projects } from '../../stores/projects.svelte';
  import { ipc } from '../../lib/ipc';

  let suggestions = $state<ProjectPathSuggestion[]>([]);
  let suggestionsOpen = $state(false);
  let activeSuggestion = $state(0);
  let suggestionRequest = 0;
  let wslDistros = $state<string[]>([]);

  let wslOptions = $derived.by(() => {
    const values = [
      projectModal.draft.defaultWslDistro,
      settings.current.defaults.wslDistro,
      ...wslDistros,
      'Ubuntu'
    ].filter((value): value is string => Boolean(value?.trim()));
    return [...new Set(values)];
  });

  $effect(() => {
    if (!projectModal.open) return;
    void loadWslDistros();
  });

  $effect(() => {
    if (!projectModal.open) return;
    if (projectModal.draft.defaultRunMode === 'wsl' && !projectModal.draft.defaultWslDistro && wslOptions[0]) {
      setField('defaultWslDistro', wslOptions[0]);
    }
  });

  $effect(() => {
    if (!projectModal.open) return;
    void refreshSuggestions(projectModal.draft.path);
  });

  function setField<K extends keyof typeof projectModal.draft>(
    key: K,
    value: (typeof projectModal.draft)[K]
  ) {
    projectModal.draft = { ...projectModal.draft, [key]: value };
  }

  function setRunMode(value: string) {
    const next = { ...projectModal.draft };
    if (!value) {
      delete next.defaultRunMode;
      delete next.defaultWslDistro;
    } else {
      next.defaultRunMode = value as RunMode;
      if (value === 'wsl' && !next.defaultWslDistro) {
        next.defaultWslDistro = wslOptions[0] ?? 'Ubuntu';
      }
      if (value !== 'wsl') delete next.defaultWslDistro;
    }
    projectModal.draft = next;
  }

  function clearAccent() {
    const next = { ...projectModal.draft };
    delete next.accentColor;
    projectModal.draft = next;
  }

  async function loadWslDistros() {
    try {
      wslDistros = await ipc.system.listWslDistros();
    } catch {
      wslDistros = [];
    }
  }

  async function refreshSuggestions(query: string) {
    const requestId = ++suggestionRequest;
    try {
      const next = await projects.suggestPaths(query);
      if (requestId !== suggestionRequest) return;
      suggestions = next;
      activeSuggestion = 0;
    } catch {
      if (requestId !== suggestionRequest) return;
      suggestions = [];
    }
  }

  async function applyPath(path: string) {
    try {
      const detected = await projects.detectFromPath(path);
      projectModal.draft = {
        ...projectModal.draft,
        path: detected.path || path,
        name: detected.suggestedName || inferName(path)
      };
    } catch {
      projectModal.draft = {
        ...projectModal.draft,
        path,
        name: inferName(path)
      };
    }
  }

  function inferName(pathValue: string): string {
    const trimmed = pathValue.replace(/[/\\]+$/, '');
    const parts = trimmed.split(/[/\\]/);
    return parts[parts.length - 1] || trimmed;
  }

  function onPathInput(e: Event) {
    const value = (e.currentTarget as HTMLInputElement).value;
    setField('path', value);
    if (projectModal.mode === 'new') setField('name', inferName(value));
    suggestionsOpen = true;
  }

  function selectSuggestion(suggestion: ProjectPathSuggestion) {
    suggestionsOpen = false;
    void applyPath(suggestion.path);
  }

  function onPathKeydown(e: KeyboardEvent) {
    if (!suggestionsOpen || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeSuggestion = (activeSuggestion + 1) % suggestions.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectSuggestion(suggestions[activeSuggestion]!);
    } else if (e.key === 'Escape') {
      suggestionsOpen = false;
    }
  }
</script>

{#if projectModal.mode === 'edit'}
  <label>
    Name
    <input
      type="text"
      required
      value={projectModal.draft.name}
      oninput={(e) => setField('name', (e.currentTarget as HTMLInputElement).value)}
    />
  </label>
{/if}

<label class="path-label">
  Path
  <div class="path-box">
    <input
      type="text"
      required
      placeholder="/home/you/project"
      value={projectModal.draft.path}
      onfocus={() => {
        suggestionsOpen = true;
        void refreshSuggestions(projectModal.draft.path);
      }}
      onblur={() => {
        window.setTimeout(() => {
          suggestionsOpen = false;
          if (projectModal.mode === 'new' && projectModal.draft.path.trim()) {
            void applyPath(projectModal.draft.path);
          }
        }, 120);
      }}
      onkeydown={onPathKeydown}
      oninput={onPathInput}
    />
    {#if suggestionsOpen && suggestions.length > 0}
      <div class="suggestions" role="listbox" aria-label="Project path suggestions">
        {#each suggestions as suggestion, index (suggestion.path)}
          <button
            type="button"
            class:active={index === activeSuggestion}
            onclick={() => selectSuggestion(suggestion)}
          >
            {#if suggestion.source === 'known'}
              <FolderOpen size={13} />
            {:else}
              <Folder size={13} />
            {/if}
            <span class="suggestion-text">
              <span class="suggestion-name">{suggestion.name}</span>
              <span class="suggestion-path">{suggestion.path}</span>
            </span>
            {#if suggestion.source === 'known'}
              <span class="tag">known</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</label>

<div class="row">
  <label>
    Default run mode
    <select
      value={projectModal.draft.defaultRunMode ?? ''}
      onchange={(e) => setRunMode((e.currentTarget as HTMLSelectElement).value)}
    >
      <option value="">Inherit from settings</option>
      <option value="windows">Windows / native</option>
      <option value="wsl">WSL</option>
    </select>
  </label>
  {#if projectModal.draft.defaultRunMode === 'wsl'}
    <label>
      WSL distro
      <select
        required
        value={projectModal.draft.defaultWslDistro ?? wslOptions[0] ?? ''}
        onchange={(e) => setField('defaultWslDistro', (e.currentTarget as HTMLSelectElement).value)}
      >
        {#each wslOptions as distro (distro)}
          <option value={distro}>{distro}</option>
        {/each}
      </select>
    </label>
  {/if}
</div>

<label class="accent">
  <span>Accent color (optional)</span>
  <div class="accent-row">
    <input
      type="color"
      value={projectModal.draft.accentColor ?? '#7aa2f7'}
      oninput={(e) => setField('accentColor', (e.currentTarget as HTMLInputElement).value)}
    />
    <button type="button" class="clear" onclick={clearAccent}>Clear</button>
  </div>
</label>

<style>
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  label input[type='text'],
  label select {
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    font: inherit;
  }
  label input[type='text']:focus,
  label select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .path-box {
    position: relative;
  }
  .path-box input {
    width: 100%;
    box-sizing: border-box;
  }
  .suggestions {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 5;
    max-height: 220px;
    overflow-y: auto;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    padding: 4px;
  }
  .suggestions button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--fg);
    border-radius: var(--radius-sm);
    padding: 6px;
    text-align: left;
    cursor: pointer;
  }
  .suggestions button:hover,
  .suggestions button.active {
    background: var(--bg-elev-3);
  }
  .suggestion-text {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .suggestion-name {
    color: var(--fg);
    font-size: 12px;
  }
  .suggestion-path {
    color: var(--muted-2);
    font-size: 10px;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    color: var(--muted-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1px 5px;
    font-size: 10px;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .accent-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .accent input[type='color'] {
    background: transparent;
    border: 1px solid var(--border);
    padding: 0;
    width: 32px;
    height: 28px;
    border-radius: var(--radius-sm);
  }
  .clear {
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: var(--radius-sm);
    padding: 4px 10px;
    font: inherit;
    cursor: pointer;
  }
  .clear:hover {
    color: var(--fg);
    border-color: var(--border-strong);
  }
</style>
