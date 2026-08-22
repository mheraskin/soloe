<script lang="ts">
  import {
    Plus,
    Settings as SettingsIcon,
    Terminal,
    FolderOpen,
    Folder,
    Trash2,
    Pencil,
    Monitor,
    Download
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import type {
    ProjectPathSuggestion,
    ProjectSearchScope
  } from '@shared/types/projects.js';
  import { runModeLabel } from '@shared/platform.js';
  import { commandPalette } from '../stores/command-palette.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import { settings } from '../stores/settings.svelte';
  import { platform } from '../stores/platform.svelte';
  import { nav } from '../stores/nav.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import * as Command from '$lib/components/ui/command';
  import * as Select from '$lib/components/ui/select';
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
  let projectDeviceId = $state<string | null>(null);
  let remoteDirectory = $state<import('@shared/types/workspaces.js').WorkspaceDirectoryListing | null>(null);
  let remoteBrowseError = $state<string | null>(null);
  let remoteBrowsing = $state(false);
  let remoteBrowseRequest = 0;
  let projectDevice = $derived(
    projectDeviceId ? deviceSessions.device(projectDeviceId) : deviceSessions.localDevice
  );
  let usingLocalProjectDevice = $derived(projectDevice?.local !== false);
  let cloneCandidates = $derived.by(() => {
    if (!projectDeviceId || projectDevice?.local) return [];
    return deviceSessions.state.projects.filter((project) =>
      project.repository?.kind === 'git'
      && !project.workspaces.some((workspace) =>
        workspace.locations.some((location) => location.deviceId === projectDeviceId)
      )
    );
  });

  function resetScopeFromSettings() {
    const defaults = settings.current.defaults;
    scope = defaults.runMode;
    wslDistro = defaults.wslDistro?.trim() || 'Ubuntu';
    projectDeviceId = deviceSessions.selectedDeviceId
      ?? deviceSessions.localDevice?.deviceId
      ?? null;
    remoteDirectory = null;
    remoteBrowseError = null;
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
    if (!usingLocalProjectDevice) return;
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

  $effect(() => {
    if (!commandPalette.isOpen || commandPalette.mode !== 'open-project') return;
    if (usingLocalProjectDevice || !projectDeviceId) return;
    const deviceId = projectDeviceId;
    void browseRemoteDevice(deviceId, undefined);
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
    if (deviceSessions.multiDeviceActive && deviceSessions.loaded) {
      list.push({
        id: 'device.show-all',
        title: 'Show sessions on all devices',
        section: 'Devices',
        icon: Monitor,
        run: () => deviceSessions.setDeviceFilter(null)
      });
      for (const device of deviceSessions.visibleDevices) {
        list.push({
          id: `device.show.${device.deviceId}`,
          title: `Show sessions on ${device.name}`,
          hint: device.available ? (device.local ? 'this device' : 'online') : device.state,
          section: 'Devices',
          icon: Monitor,
          run: () => deviceSessions.setDeviceFilter(device.deviceId)
        });
      }
      for (const projection of deviceSessions.sessions) {
        list.push({
          id: `session.switch.${projection.key}`,
          title: `Switch to ${projection.session.name || '(unnamed)'}`,
          hint: `${projection.deviceName} · ${projection.session.cwd}`,
          section: 'Sessions',
          icon: Terminal,
          run: () => deviceSessions.selectSession(projection.key)
        });
      }
    } else {
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

  async function browseRemoteDevice(deviceId: string, path?: string): Promise<void> {
    const requestId = ++remoteBrowseRequest;
    remoteBrowsing = true;
    remoteBrowseError = null;
    try {
      const listing = await deviceSessions.browseWorkspaceDirectories(deviceId, path);
      if (requestId !== remoteBrowseRequest) return;
      remoteDirectory = listing;
      query = listing.path;
    } catch (error) {
      if (requestId !== remoteBrowseRequest) return;
      remoteBrowseError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === remoteBrowseRequest) remoteBrowsing = false;
    }
  }

  async function openRemoteProject(path: string): Promise<void> {
    if (!projectDeviceId || !projectDevice) return;
    try {
      await deviceSessions.openProjectOnDevice(projectDeviceId, {
        path,
        ...(projectDevice.platform ? { defaultRunMode: projectDevice.platform } : {})
      });
      commandPalette.close();
    } catch (error) {
      reportError(error);
    }
  }

  async function cloneProjectOnSelectedDevice(
    project: import('@shared/types/multi-device-sessions.js').ProjectView
  ): Promise<void> {
    if (!projectDeviceId) return;
    const workspace = project.workspaces[0];
    if (!workspace) return;
    const targetPath = remoteDirectory
      ? `${remoteDirectory.path}${remoteDirectory.path.endsWith(remoteDirectory.separator) ? '' : remoteDirectory.separator}${safeFolderName(project.name)}`
      : undefined;
    try {
      const plan = await deviceSessions.planCreate({
        workspaceKey: workspace.key,
        targetDeviceId: projectDeviceId,
        ...(targetPath ? { targetPath } : {}),
        session: {
          name: `${project.name} terminal`,
          launch: { type: 'terminal', shell: settings.current.defaults.shell }
        }
      });
      if (plan.action !== 'use-existing-location') {
        await deviceSessions.executePreparation(plan.planId);
      }
      commandPalette.close();
    } catch (error) {
      reportError(error);
    }
  }

  function safeFolderName(value: string): string {
    return value.trim().replace(/[\\/:*?"<>|]+/gu, '-').replace(/^\.+|\.+$/gu, '') || 'project';
  }

  function onOpenChange(next: boolean) {
    if (!next) commandPalette.close();
  }

  function drillIntoHighlighted() {
    if (!usingLocalProjectDevice && remoteDirectory) {
      const target = remoteDirectory.directories.find((directory) => directory.path === highlight)
        ?? remoteDirectory.directories[0];
      if (target && projectDeviceId) void browseRemoteDevice(projectDeviceId, target.path);
      return;
    }
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
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && (pathSuggestions.length > 0 || remoteDirectory?.directories.length)) {
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
  class="mobile-command-dialog sm:max-w-xl"
>
  <Command.Input
    placeholder={commandPalette.mode === 'open-project'
      ? 'Open project at path…'
      : 'Type a command or session name…'}
    bind:value={query}
  />
  {#if commandPalette.mode === 'open-project'}
    <div class="mobile-command-scope flex items-center gap-1.5 border-b border-border px-3 py-1.5">
      {#if deviceSessions.multiDeviceActive && deviceSessions.visibleDevices.length > 0}
        <Select.Root
          type="single"
          value={projectDeviceId ?? undefined}
          onValueChange={(value) => {
            projectDeviceId = value;
            pathSuggestions = [];
            remoteDirectory = null;
            query = '';
          }}
        >
          <Select.Trigger class="h-7 min-w-36 max-w-52 text-[11px]">
            <span class="flex min-w-0 items-center gap-1.5">
              <Monitor class="size-3" />
              <span class="truncate">{projectDevice?.name ?? 'Choose device'}</span>
            </span>
          </Select.Trigger>
          <Select.Content>
            {#each deviceSessions.visibleDevices as device (device.deviceId)}
              <Select.Item value={device.deviceId} label={device.name} disabled={!device.available}>
                <span class="flex items-center gap-2">
                  <span class={`size-2 rounded-full ${device.available ? 'bg-success' : 'bg-muted-foreground/50'}`}></span>
                  <span>{device.name}</span>
                  <span class="text-[10px] text-muted-foreground">{device.local ? 'this device' : device.state}</span>
                </span>
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {/if}
      {#if usingLocalProjectDevice}
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
          {runModeLabel(platform.current.defaultRunMode)}
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
      {:else if remoteDirectory}
        <button
          type="button"
          class="max-w-56 truncate rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          disabled={!remoteDirectory.parentPath || remoteBrowsing}
          onclick={() => projectDeviceId && void browseRemoteDevice(projectDeviceId, remoteDirectory?.parentPath ?? undefined)}
        >
          {remoteDirectory.parentPath ? '← Parent folder' : 'Workspace root'}
        </button>
      {/if}
      <span class="mobile-desktop-hint ml-auto text-[10px] text-muted-foreground">
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
      {#if !usingLocalProjectDevice}
        {#if remoteBrowsing}
          <Command.Empty>Loading folders on {projectDevice?.name ?? 'device'}…</Command.Empty>
        {:else if remoteBrowseError}
          <Command.Empty>{remoteBrowseError}</Command.Empty>
        {:else if remoteDirectory}
          <Command.Group heading={`Open on ${projectDevice?.name ?? 'device'}`}>
            <Command.Item value={`${remoteDirectory.path} open current folder`} onSelect={() => openRemoteProject(remoteDirectory!.path)}>
              <FolderOpen />
              <span class="flex-1 truncate">Open this folder as a project</span>
            </Command.Item>
            {#each remoteDirectory.directories as directory (directory.path)}
              <Command.Item value={directory.path} onSelect={() => openRemoteProject(directory.path)}>
                <Folder />
                <span class="block min-w-0 flex-1 truncate font-mono text-sm" title={directory.path}>{directory.name}</span>
              </Command.Item>
            {/each}
          </Command.Group>
          {#if cloneCandidates.length > 0}
            <Command.Group heading="Clone from another device">
              {#each cloneCandidates as project (project.key)}
                <Command.Item value={`clone ${project.name}`} onSelect={() => cloneProjectOnSelectedDevice(project)}>
                  <Download />
                  <span class="flex-1 truncate">Clone {project.name} here</span>
                </Command.Item>
              {/each}
            </Command.Group>
          {/if}
        {/if}
      {:else if pathSuggestions.length === 0}
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
