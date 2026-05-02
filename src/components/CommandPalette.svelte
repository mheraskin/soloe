<script lang="ts">
  import {
    Plus,
    Settings as SettingsIcon,
    Terminal,
    FolderOpen,
    Folder,
    Trash2,
    Pencil,
    Activity
  } from 'lucide-svelte';
  import type { ComponentType, SvelteComponent } from 'svelte';
  import type { ProjectPathSuggestion } from '@shared/types/projects.js';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import { settings } from '../stores/settings.svelte';
  import { diagnosticsPane } from '../stores/diagnostics-pane.svelte';
  import { nav } from '../stores/nav.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import { rank } from '../lib/fuzzy';

  interface Command {
    id: string;
    title: string;
    hint?: string;
    section: string;
    icon: ComponentType<SvelteComponent>;
    run: () => void | Promise<void>;
  }

  let query = $state('');
  let activeIndex = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let pathSuggestions = $state<ProjectPathSuggestion[]>([]);
  let suggestRequest = 0;
  let debounceHandle = 0;

  $effect(() => {
    if (commandPalette.isOpen) {
      query = '';
      activeIndex = 0;
      queueMicrotask(() => inputEl?.focus());
    }
  });

  $effect(() => {
    void commandPalette.mode;
    query = '';
    activeIndex = 0;
    pathSuggestions = [];
  });

  $effect(() => {
    if (!commandPalette.isOpen) return;
    if (commandPalette.mode !== 'open-project') return;
    const q = query;
    if (debounceHandle) {
      window.clearTimeout(debounceHandle);
      debounceHandle = 0;
    }
    debounceHandle = window.setTimeout(() => {
      const requestId = ++suggestRequest;
      void projects
        .suggestPaths(q)
        .then((next) => {
          if (requestId !== suggestRequest) return;
          pathSuggestions = next;
          if (activeIndex >= next.length) activeIndex = Math.max(0, next.length - 1);
        })
        .catch(() => {
          if (requestId !== suggestRequest) return;
          pathSuggestions = [];
        });
    }, 80);
    return () => {
      if (debounceHandle) {
        window.clearTimeout(debounceHandle);
        debounceHandle = 0;
      }
    };
  });

  let commands = $derived.by<Command[]>(() => {
    const list: Command[] = [];

    list.push({
      id: 'action.new-terminal',
      title: 'New terminal',
      section: 'Actions',
      icon: Plus,
      run: () => {
        const sel = sessions.selected;
        void sessions
          .createWithDefaults({
            ...(sel?.projectId ? { projectId: sel.projectId } : {}),
            ...(sel?.cwd ? { cwd: sel.cwd } : {})
          })
          .catch(reportError);
      }
    });
    list.push({
      id: 'action.open-project',
      title: 'Open project',
      section: 'Actions',
      icon: FolderOpen,
      run: () => commandPalette.open('open-project')
    });
    list.push({
      id: 'action.open-settings',
      title: 'Open settings',
      section: 'Actions',
      icon: SettingsIcon,
      run: () => settings.openDrawer()
    });
    list.push({
      id: 'action.open-diagnostics',
      title: 'Open diagnostics',
      section: 'Actions',
      icon: Activity,
      run: () => diagnosticsPane.show()
    });

    for (const session of sessions.sessions) {
      list.push({
        id: `session.switch.${session.id}`,
        title: `Switch to ${session.name || '(unnamed)'}`,
        hint: session.cwd,
        section: 'Sessions',
        icon: Terminal,
        run: () => sessions.select(session.id)
      });
    }

    for (const project of projects.recents) {
      list.push({
        id: `project.edit.${project.id}`,
        title: `Edit project: ${project.name}`,
        hint: project.path,
        section: 'Projects',
        icon: Pencil,
        run: () => projectModal.openEdit(project)
      });
      list.push({
        id: `project.add-terminal.${project.id}`,
        title: `New terminal in ${project.name}`,
        hint: project.path,
        section: 'Projects',
        icon: FolderOpen,
        run: () =>
          void sessions
            .createWithDefaults({ projectId: project.id, cwd: project.path })
            .catch(reportError)
      });
    }

    if (sessions.selected) {
      list.push({
        id: 'action.delete-active',
        title: `Delete active session: ${sessions.selected.name || '(unnamed)'}`,
        section: 'Actions',
        icon: Trash2,
        run: () => nav.closeActive()
      });
    }

    return list;
  });

  let filtered = $derived.by<Command[]>(() => {
    const q = query.trim();
    if (!q) return commands;
    return rank(q, commands, (c) => `${c.title} ${c.hint ?? ''}`).map((r) => r.item);
  });

  $effect(() => {
    if (commandPalette.mode === 'commands' && activeIndex >= filtered.length) {
      activeIndex = Math.max(0, filtered.length - 1);
    }
  });

  let groups = $derived.by<{ section: string; items: Command[] }[]>(() => {
    const order: string[] = [];
    const buckets: Record<string, Command[]> = {};
    for (const cmd of filtered) {
      if (!buckets[cmd.section]) {
        buckets[cmd.section] = [];
        order.push(cmd.section);
      }
      buckets[cmd.section]!.push(cmd);
    }
    return order.map((section) => ({ section, items: buckets[section]! }));
  });

  function runCommand() {
    const cmd = filtered[activeIndex];
    if (!cmd) return;
    commandPalette.close();
    void cmd.run();
  }

  async function openSuggestion(suggestion: ProjectPathSuggestion) {
    try {
      const opened = await projects.open({ path: suggestion.path });
      try {
        await ipc.git.worktrees({ repoPath: opened.path });
      } catch {
        // worktree priming is best-effort
      }
      commandPalette.close();
    } catch (err) {
      reportError(err);
    }
  }

  function runActiveSuggestion() {
    const suggestion = pathSuggestions[activeIndex];
    if (!suggestion) return;
    void openSuggestion(suggestion);
  }

  function onKey(e: KeyboardEvent) {
    if (!commandPalette.isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      commandPalette.close();
      return;
    }
    const listLength =
      commandPalette.mode === 'open-project' ? pathSuggestions.length : filtered.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(listLength - 1, activeIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(0, activeIndex - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (commandPalette.mode === 'open-project') {
        runActiveSuggestion();
      } else {
        runCommand();
      }
      return;
    }
    if (e.key === 'Backspace' && commandPalette.mode === 'open-project' && query === '') {
      e.preventDefault();
      commandPalette.open('commands');
      return;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if commandPalette.isOpen}
  <div class="backdrop" onclick={() => commandPalette.close()} role="presentation"></div>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
    <input
      bind:this={inputEl}
      bind:value={query}
      type="text"
      placeholder={commandPalette.mode === 'open-project'
        ? 'Open project at path…'
        : 'Type a command or session name…'}
      autocomplete="off"
      spellcheck="false"
    />
    <div class="results">
      {#if commandPalette.mode === 'open-project'}
        {#if pathSuggestions.length === 0}
          <p class="empty">{query.trim() ? 'No matches' : 'Start typing a path…'}</p>
        {:else}
          {#each pathSuggestions as suggestion, index (suggestion.path)}
            <button
              class="row suggestion"
              class:active={index === activeIndex}
              onmousemove={() => (activeIndex = index)}
              onclick={() => {
                activeIndex = index;
                runActiveSuggestion();
              }}
            >
              {#if suggestion.source === 'known'}
                <FolderOpen size={14} />
              {:else}
                <Folder size={14} />
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
        {/if}
      {:else if filtered.length === 0}
        <p class="empty">No matches</p>
      {:else}
        {#each groups as group (group.section)}
          <div class="section-label">{group.section}</div>
          {#each group.items as cmd (cmd.id)}
            {@const flatIdx = filtered.indexOf(cmd)}
            <button
              class="row"
              class:active={flatIdx === activeIndex}
              onmousemove={() => (activeIndex = flatIdx)}
              onclick={() => {
                activeIndex = flatIdx;
                runCommand();
              }}
            >
              <cmd.icon size={14} />
              <span class="title">{cmd.title}</span>
              {#if cmd.hint}
                <span class="hint">{cmd.hint}</span>
              {/if}
            </button>
          {/each}
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
    z-index: 200;
  }
  .palette {
    position: fixed;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    z-index: 201;
    width: 560px;
    max-width: 92vw;
    max-height: 70vh;
    background: var(--bg-elev-1);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  input {
    background: transparent;
    color: var(--fg);
    border: none;
    outline: none;
    padding: 14px 16px;
    font-size: 14px;
    border-bottom: 1px solid var(--border);
  }
  .results {
    flex: 1;
    overflow-y: auto;
    padding: 6px;
    display: flex;
    flex-direction: column;
  }
  .section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted-2);
    padding: 8px 10px 4px;
  }
  .row {
    background: transparent;
    border: 1px solid transparent;
    color: var(--fg);
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    overflow: hidden;
  }
  .row.active {
    background: var(--bg-elev-3);
    border-color: var(--border-strong);
  }
  .row .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row .hint {
    color: var(--muted);
    font-size: 11px;
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
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
    font-size: 13px;
  }
  .suggestion-path {
    color: var(--muted-2);
    font-size: 11px;
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
  .empty {
    margin: 0;
    padding: 12px;
    color: var(--muted-2);
    font-size: 13px;
    font-style: italic;
    text-align: center;
  }
</style>
