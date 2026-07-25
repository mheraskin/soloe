<script lang="ts">
  import {
    Plus,
    Settings as SettingsIcon,
    Terminal,
    FolderOpen,
    Folder,
    Trash2,
    Pencil
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import type {
    ProjectPathSuggestion,
    ProjectSearchScope
  } from '@shared/types/projects.js';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import { settings } from '../stores/settings.svelte';
  import { platform } from '../stores/platform.svelte';
  import { nav } from '../stores/nav.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import * as Command from '$lib/components/ui/command';
  import { Badge } from '$lib/components/ui/badge';
  import { cn } from '$lib/utils';

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
  let scope = $state<ProjectSearchScope>('windows');
  let wslDistro = $state<string>('Ubuntu');
  let highlight = $state('');
  let suggestRequest = 0;
  let debounceHandle = 0;

  function resetScopeFromSettings() {
    const defaults = settings.current.defaults;
    scope = defaults.runMode;
    wslDistro = defaults.wslDistro?.trim() || 'Ubuntu';
  }

  $effect(() => {
    if (commandPalette.isOpen) {
      query = '';
    }
  });

  $effect(() => {
    const mode = commandPalette.mode;
    query = '';
    pathSuggestions = [];
    if (mode === 'open-project') resetScopeFromSettings();
  });

  $effect(() => {
    if (!commandPalette.isOpen) return;
    if (commandPalette.mode !== 'open-project') return;
    const q = query;
    const requestScope = scope;
    const requestDistro = wslDistro;
    if (debounceHandle) {
      window.clearTimeout(debounceHandle);
      debounceHandle = 0;
    }
    debounceHandle = window.setTimeout(() => {
      const requestId = ++suggestRequest;
      void projects
        .suggestPaths(q, { scope: requestScope, wslDistro: requestDistro })
        .then((next) => {
          if (requestId !== suggestRequest) return;
          pathSuggestions = next.suggestions;
          if (next.scope !== scope) scope = next.scope;
          if (next.scope === 'wsl' && next.wslDistro && next.wslDistro !== wslDistro) {
            wslDistro = next.wslDistro;
          }
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
      id: 'action.new-session',
      title: 'New session',
      section: 'Actions',
      icon: Plus,
      run: () => {
        const sel = sessions.selected;
        void sessions
          .createPreferredWithDefaults({
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
      run: () => settings.openDialog()
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
        id: `project.add-session.${project.id}`,
        title: `New session in ${project.name}`,
        hint: project.path,
        section: 'Projects',
        icon: FolderOpen,
        run: () =>
          void sessions
            .createPreferredWithDefaults({ projectId: project.id, cwd: project.path })
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
      const opened = await projects.open({
        path: suggestion.path,
        ...(suggestion.scope === 'wsl'
          ? {
              defaultRunMode: 'wsl' as const,
              ...(suggestion.wslDistro ? { defaultWslDistro: suggestion.wslDistro } : {})
            }
          : { defaultRunMode: suggestion.scope })
      });
      try {
        await ipc.git.worktrees({
          repoPath: opened.path,
          force: true,
          ...(opened.defaultRunMode ? { runMode: opened.defaultRunMode } : {}),
          ...(opened.defaultWslDistro ? { wslDistro: opened.defaultWslDistro } : {})
        });
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

  function drillIntoHighlighted() {
    const target = pathSuggestions.find((s) => s.path === highlight) ?? pathSuggestions[0];
    if (!target) return;
    const sep = target.scope === 'windows' ? '\\' : '/';
    const next = target.path.endsWith(sep) ? target.path : `${target.path}${sep}`;
    query = next;
    if (target.scope === 'wsl') {
      scope = 'wsl';
      if (target.wslDistro) wslDistro = target.wslDistro;
    } else {
      scope = target.scope;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!commandPalette.isOpen) return;
    if (commandPalette.mode !== 'open-project') return;
    if (e.key === 'Backspace' && query === '') {
      e.preventDefault();
      commandPalette.open('commands');
      return;
    }
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && pathSuggestions.length > 0) {
      if (e.key === 'ArrowRight') {
        const input = e.target as HTMLInputElement | null;
        if (input && input.selectionStart !== null && input.selectionStart < query.length) {
          return;
        }
      }
      e.preventDefault();
      drillIntoHighlighted();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<Command.Dialog
  open={commandPalette.isOpen}
  {onOpenChange}
  bind:value={highlight}
  shouldFilter={commandPalette.mode === 'commands'}
  class="sm:max-w-xl"
>
  <Command.Input
    placeholder={commandPalette.mode === 'open-project'
      ? 'Open project at path…'
      : 'Type a command or session name…'}
    bind:value={query}
  />
  {#if commandPalette.mode === 'open-project'}
    <div class="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
      <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Search</span>
      <div class="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-0.5">
        <button
          type="button"
          class={cn(
            'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
            scope === platform.current.defaultRunMode
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onclick={() => (scope = platform.current.defaultRunMode)}
        >
          {platform.current.platform === 'linux' ? 'Linux' : 'Windows'}
        </button>
        {#if platform.current.supportsWsl}
        <button
          type="button"
          class={cn(
            'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
            scope === 'wsl'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onclick={() => (scope = 'wsl')}
        >
          WSL: {wslDistro}
        </button>
        {/if}
      </div>
      <span class="ml-auto text-[10px] text-muted-foreground">
        <kbd class="rounded border border-border bg-muted px-1 font-mono">Tab</kbd>
        <span class="mx-0.5">enter folder</span>
        <span class="opacity-50">·</span>
        <kbd class="ml-1 rounded border border-border bg-muted px-1 font-mono">↵</kbd>
        <span class="mx-0.5">open</span>
      </span>
    </div>
  {/if}
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
              <span
                class="block min-w-0 flex-1 truncate font-mono text-sm"
                style="direction: rtl; text-align: left;"
                title={suggestion.path}
              >{'‎' + (suggestion.displayPath ?? suggestion.path)}</span>
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
