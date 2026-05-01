<script lang="ts">
  import {
    Plus,
    FolderPlus,
    Settings as SettingsIcon,
    Terminal,
    FolderOpen,
    Trash2,
    Pencil,
    Activity
  } from 'lucide-svelte';
  import type { ComponentType, SvelteComponent } from 'svelte';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { modal } from '../stores/modal.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import { settings } from '../stores/settings.svelte';
  import { diagnosticsPane } from '../stores/diagnostics-pane.svelte';
  import { nav } from '../stores/nav.svelte';
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

  $effect(() => {
    if (commandPalette.open) {
      query = '';
      activeIndex = 0;
      queueMicrotask(() => inputEl?.focus());
    }
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
        modal.openNew({
          ...(sel?.cwd ? { cwd: sel.cwd } : {}),
          ...(sel?.projectId ? { projectId: sel.projectId } : {})
        });
      }
    });
    list.push({
      id: 'action.new-project',
      title: 'New project',
      section: 'Actions',
      icon: FolderPlus,
      run: () => projectModal.openNew()
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
          modal.openNew({
            cwd: project.path,
            projectId: project.id
          })
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
    if (activeIndex >= filtered.length) activeIndex = Math.max(0, filtered.length - 1);
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

  function runActive() {
    const cmd = filtered[activeIndex];
    if (!cmd) return;
    commandPalette.close();
    void cmd.run();
  }

  function onKey(e: KeyboardEvent) {
    if (!commandPalette.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      commandPalette.close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(filtered.length - 1, activeIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(0, activeIndex - 1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runActive();
      return;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if commandPalette.open}
  <div class="backdrop" onclick={() => commandPalette.close()} role="presentation"></div>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
    <input
      bind:this={inputEl}
      bind:value={query}
      type="text"
      placeholder="Type a command or session name…"
      autocomplete="off"
      spellcheck="false"
    />
    <div class="results">
      {#if filtered.length === 0}
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
                runActive();
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
  .empty {
    margin: 0;
    padding: 12px;
    color: var(--muted-2);
    font-size: 13px;
    font-style: italic;
    text-align: center;
  }
</style>
