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
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
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
  import * as Command from '$lib/components/ui/command';
  import { Badge } from '$lib/components/ui/badge';

  interface Cmd {
    id: string;
    title: string;
    hint?: string;
    section: string;
    icon: Component<any, {}, ''>;
    run: () => void | Promise<void>;
  }

  let query = $state('');
  let pathSuggestions = $state<ProjectPathSuggestion[]>([]);
  let suggestRequest = 0;
  let debounceHandle = 0;

  $effect(() => {
    if (commandPalette.isOpen) {
      query = '';
    }
  });

  $effect(() => {
    void commandPalette.mode;
    query = '';
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

  let commands = $derived.by<Cmd[]>(() => {
    const list: Cmd[] = [];

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

  let groups = $derived.by<{ section: string; items: Cmd[] }[]>(() => {
    const order: string[] = [];
    const buckets: Record<string, Cmd[]> = {};
    for (const cmd of commands) {
      if (!buckets[cmd.section]) {
        buckets[cmd.section] = [];
        order.push(cmd.section);
      }
      buckets[cmd.section]!.push(cmd);
    }
    return order.map((section) => ({ section, items: buckets[section]! }));
  });

  function runCommand(cmd: Cmd) {
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

  function onOpenChange(next: boolean) {
    if (!next) commandPalette.close();
  }

  function onKey(e: KeyboardEvent) {
    if (!commandPalette.isOpen) return;
    if (e.key === 'Backspace' && commandPalette.mode === 'open-project' && query === '') {
      e.preventDefault();
      commandPalette.open('commands');
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<Command.Dialog
  open={commandPalette.isOpen}
  {onOpenChange}
  shouldFilter={commandPalette.mode === 'commands'}
  bind:value={query}
  class="sm:max-w-xl"
>
  <Command.Input
    placeholder={commandPalette.mode === 'open-project'
      ? 'Open project at path…'
      : 'Type a command or session name…'}
    bind:value={query}
  />
  <Command.List class="max-h-[60vh]">
    {#if commandPalette.mode === 'open-project'}
      {#if pathSuggestions.length === 0}
        <Command.Empty>{query.trim() ? 'No matches' : 'Start typing a path…'}</Command.Empty>
      {:else}
        <Command.Group heading="Open project">
          {#each pathSuggestions as suggestion (suggestion.path)}
            <Command.Item
              value={suggestion.path}
              onSelect={() => openSuggestion(suggestion)}
            >
              {#if suggestion.source === 'known'}
                <FolderOpen />
              {:else}
                <Folder />
              {/if}
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-sm">{suggestion.name}</span>
                <span class="truncate font-mono text-[11px] text-muted-foreground">{suggestion.path}</span>
              </div>
              {#if suggestion.source === 'known'}
                <Badge variant="outline" class="text-[10px]">known</Badge>
              {/if}
            </Command.Item>
          {/each}
        </Command.Group>
      {/if}
    {:else}
      <Command.Empty>No matches</Command.Empty>
      {#each groups as group (group.section)}
        <Command.Group heading={group.section}>
          {#each group.items as cmd (cmd.id)}
            <Command.Item value={`${cmd.title} ${cmd.hint ?? ''}`} onSelect={() => runCommand(cmd)}>
              <cmd.icon />
              <span class="flex-1 truncate">{cmd.title}</span>
              {#if cmd.hint}
                <span class="max-w-[180px] truncate font-mono text-[11px] text-muted-foreground">{cmd.hint}</span>
              {/if}
            </Command.Item>
          {/each}
        </Command.Group>
      {/each}
    {/if}
  </Command.List>
</Command.Dialog>
