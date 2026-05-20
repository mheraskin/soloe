<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { ModeWatcher, setMode } from 'mode-watcher';
  import { Maximize2, Minus, PanelLeftOpen, Settings, X } from '@lucide/svelte';
  import { sessions } from './stores/sessions.svelte';
  import { settings } from './stores/settings.svelte';
  import { projects } from './stores/projects.svelte';
  import { notes } from './stores/notes.svelte';
  import { git } from './stores/git.svelte';
  import { nav } from './stores/nav.svelte';
  import { commandPalette } from './stores/command-palette.svelte';
  import { filePalette } from './stores/file-palette.svelte';
  import { newSessionPicker } from './stores/new-session-picker.svelte';
  import { rightRail } from './stores/right-rail.svelte';
  import { sidebar } from './stores/sidebar.svelte';
  import { browserStore } from './stores/browser.svelte';
  import { vaultStore } from './stores/vault.svelte';
  import { reportError } from './stores/toast.svelte';
  import { ipc } from './lib/ipc';
  import { agentIntegrationSetup } from './stores/agent-integration-setup.svelte';
  import {
    Keymap,
    projectIndexFromEvent,
    shouldIgnoreInTextInput,
    tabIndexFromEvent
  } from './lib/keymap';
  import { kbdHints } from './stores/kbd-hints.svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { Toaster } from '$lib/components/ui/sonner';
  import Sidebar from './components/Sidebar.svelte';
  import TerminalArea from './components/TerminalArea.svelte';
  import RightRail from './components/RightRail.svelte';
  import NewSessionModal from './components/NewSessionModal.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import ProjectModal from './components/ProjectModal.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import FilePalette from './components/FilePalette.svelte';
  import NewSessionPickerDialog from './components/NewSessionPickerDialog.svelte';
  import SessionHandoffDialog from './components/SessionHandoffDialog.svelte';
  import AgentIntegrationSetupDialog from './components/AgentIntegrationSetupDialog.svelte';
  import AgentNotificationToasts from './components/AgentNotificationToasts.svelte';
  import appIconUrl from '../build/favicon.svg';

  let appliedTheme: string | null = null;

  onMount(() => {
    sessions.attachListeners();
    settings.attachListeners();
    projects.attachListeners();
    notes.attachListeners();
    git.attachListeners();
    const detachToast = ipc.notify.onToast((t) => {
      const opts = t.description ? { description: t.description } : undefined;
      if (t.severity === 'error') toast.error(t.message, opts);
      else if (t.severity === 'success') toast.success(t.message, opts);
      else if (t.severity === 'warning') toast.warning(t.message, opts);
      else toast(t.message, opts);
    });
    void loadInitialState();
    const detachKbdHints = kbdHints.attach();
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      detachKbdHints();
      detachToast();
      sessions.detach();
      settings.detach();
      projects.detach();
      notes.detach();
      git.detach();
    };
  });

  async function loadInitialState(): Promise<void> {
    try {
      await Promise.all([settings.load(), projects.load(), sessions.load()]);
      await promptForAgentIntegrationSetup();
    } catch (err) {
      reportError(err);
    }
  }

  async function promptForAgentIntegrationSetup(): Promise<void> {
    const status = await ipc.agentIntegration.status();
    const needsSetup = status.hosts.some(
      (h) => h.host.available && (!h.claude.current || !h.codex.current)
    );
    if (!needsSetup) return;
    agentIntegrationSetup.show(status);
  }

  $effect(() => {
    const theme = settings.current.appearance.theme;
    if (theme === appliedTheme) return;
    appliedTheme = theme;
    untrack(() => setMode(theme));
  });

  // Rail fullscreen takes over the main area: terminal hides, the rail
  // expands to fill the remaining space (sidebar stays put). Applies to
  // whichever tab is active (diff, notes, inspector).
  let railFullscreen = $derived(rightRail.open && rightRail.fullscreen);

  // Keep the rail store's notion of the active worktree in sync with the
  // selected session, so its per-worktree open/fullscreen/tab state can be
  // recalled when bouncing between worktrees.
  $effect(() => {
    const cwd = sessions.selected?.cwd ?? null;
    rightRail.setActiveCwd(cwd);
    browserStore.setActiveCwd(cwd);
    vaultStore.setActiveCwd(cwd);
  });

  // Poll git status/diff for every worktree of every known project at the
  // slow tier so sessionless worktrees still get a +N −N indicator. Sessions
  // bump matching worktrees to the fast tier via the next effect.
  $effect(() => {
    const list = projects.projects;
    const intents = list.map((p) => ({
      repoPath: p.path,
      ...(p.defaultRunMode ? { runMode: p.defaultRunMode } : {}),
      ...(p.defaultWslDistro ? { wslDistro: p.defaultWslDistro } : {})
    }));
    void git.refreshProjectWorktrees(intents);
  });

  // Drive git status/diff polling for every worktree that has a session.
  // Worktrees with at least one running/starting session (or holding the
  // selected session) tick every 1.5s; idle ones fall back to 15s so we
  // don't burn `git diff` on dozens of dormant projects.
  $effect(() => {
    const list = sessions.sessions;
    const selectedId = sessions.selectedId;
    type Intent = { fast: boolean; runMode?: 'windows' | 'wsl'; wslDistro?: string };
    const intentByCwd = new Map<string, Intent>();
    for (const s of list) {
      const cwd = s.cwd?.trim();
      if (!cwd) continue;
      const status = sessions.statusFor(s.id);
      const active = status === 'running' || status === 'starting' || s.id === selectedId;
      const prev = intentByCwd.get(cwd);
      const next: Intent = {
        fast: (prev?.fast ?? false) || active,
        runMode: prev?.runMode ?? s.runMode,
        wslDistro: prev?.wslDistro ?? s.wslDistro
      };
      intentByCwd.set(cwd, next);
    }
    const intents = Array.from(intentByCwd, ([cwd, info]) => ({
      cwd,
      fast: info.fast,
      ...(info.runMode ? { runMode: info.runMode } : {}),
      ...(info.wslDistro ? { wslDistro: info.wslDistro } : {})
    }));
    git.setWorktreePolling(intents);
  });

  function consume(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function isTerminalKeyTarget(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    return Boolean(target?.closest('.xterm'));
  }

  // Ctrl+/-/0 should drive the rail browser's zoom whenever the browser tab
  // is the active rail surface — independent of focus, since the URL bar and
  // toolbar buttons live in the IDE chrome and aren't seen by the webview's
  // own before-input-event hook.
  function isBrowserTabActive(): boolean {
    return rightRail.open && rightRail.activeTab === 'browser';
  }

  function dispatchBrowserZoom(direction: 'in' | 'out' | 'reset'): void {
    window.dispatchEvent(new CustomEvent('soloe:browser-zoom', { detail: { direction } }));
  }

  // Ctrl+; should ping-pong: if the rail is currently focused, snap back to
  // the terminal; otherwise jump into the rail's primary input. We probe
  // document.activeElement at keypress time rather than tracking focus in a
  // store because the latter would need to wire into every focusable child.
  async function toggleTerminalFocus(): Promise<void> {
    const active = document.activeElement as HTMLElement | null;
    const inRail = Boolean(active?.closest('aside[aria-label="Session rail"]'));
    if (inRail) {
      // Fullscreen covers the terminal; exit it so the refocus event has a
      // pane to land on. The TerminalPane only attaches its listener on
      // mount, so wait for the layout to flush before dispatching.
      if (rightRail.fullscreen) {
        rightRail.fullscreen = false;
        await tick();
      }
      window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
      return;
    }
    if (!rightRail.open) {
      window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
      return;
    }
    window.dispatchEvent(new CustomEvent('soloe:refocus-rail'));
  }

  function selectedSessionContext(): { projectId?: string; cwd?: string; branch?: string } {
    const sel = sessions.selected;
    return {
      ...(sel?.projectId ? { projectId: sel.projectId } : {}),
      ...(sel?.cwd ? { cwd: sel.cwd } : {}),
      ...(sel?.lastBranch ? { branch: sel.lastBranch } : {})
    };
  }

  function onKey(e: KeyboardEvent) {
    if (Keymap.commandPalette.match(e)) {
      consume(e);
      commandPalette.toggle();
      return;
    }
    if (Keymap.filePalette.match(e)) {
      consume(e);
      filePalette.toggle();
      return;
    }
    if (Keymap.openSettings.match(e)) {
      consume(e);
      settings.toggleDialog();
      return;
    }
    if (Keymap.openProject.match(e)) {
      consume(e);
      commandPalette.open('open-project');
      return;
    }
    if (Keymap.newSession.match(e)) {
      consume(e);
      void sessions
        .createPreferredWithDefaults(selectedSessionContext())
        .catch(reportError);
      return;
    }
    if (Keymap.newSessionPicker.match(e)) {
      consume(e);
      void sessions
        .createPreferredWithDefaults(selectedSessionContext())
        .catch(reportError);
      return;
    }
    if (Keymap.terminalFind.match(e)) {
      consume(e);
      window.dispatchEvent(new CustomEvent('soloe:terminal-find'));
      return;
    }
    if (Keymap.zoomIn.match(e)) {
      consume(e);
      if (isBrowserTabActive()) {
        dispatchBrowserZoom('in');
      } else {
        void ipc.window.zoomIn().catch(reportError);
      }
      return;
    }
    if (Keymap.zoomOut.match(e)) {
      consume(e);
      if (isBrowserTabActive()) {
        dispatchBrowserZoom('out');
      } else {
        void ipc.window.zoomOut().catch(reportError);
      }
      return;
    }
    if (Keymap.zoomReset.match(e)) {
      consume(e);
      if (isBrowserTabActive()) {
        dispatchBrowserZoom('reset');
      }
      // No global "reset zoom" action — only forwarded when the browser is
      // active, since the IDE chrome doesn't currently expose a reset.
      return;
    }
    if (Keymap.toggleNotesRail.match(e)) {
      consume(e);
      rightRail.toggleTab('notes');
      return;
    }
    if (Keymap.toggleDiffRail.match(e)) {
      consume(e);
      rightRail.toggleTab('diff');
      return;
    }
    if (Keymap.toggleFilesRail.match(e)) {
      consume(e);
      rightRail.toggleTab('files');
      return;
    }
    if (Keymap.toggleFeatureRail.match(e)) {
      consume(e);
      rightRail.toggleTab('feature');
      return;
    }
    if (Keymap.toggleBrowserRail.match(e)) {
      consume(e);
      rightRail.toggleTab('browser');
      return;
    }
    if (Keymap.toggleSidebar.match(e)) {
      consume(e);
      sidebar.toggle();
      return;
    }
    if (Keymap.toggleRailFullscreen.match(e)) {
      consume(e);
      // Toggle fullscreen on whichever tab is currently active. If the rail
      // is closed, the store opens it before flipping the flag so the user
      // sees the result instead of toggling invisibly.
      rightRail.toggleFullscreen();
      return;
    }
    if (Keymap.toggleTerminalFocus.match(e)) {
      consume(e);
      void toggleTerminalFocus();
      return;
    }
    if (commandPalette.isOpen || filePalette.open) return;
    if (
      Keymap.deleteSelectedSession.match(e)
      && (!shouldIgnoreInTextInput(e) || isTerminalKeyTarget(e))
    ) {
      consume(e);
      void nav.closeActive();
      return;
    }
    const projectIdx = projectIndexFromEvent(e);
    if (projectIdx !== null) {
      consume(e);
      nav.selectProjectByIndex(projectIdx);
      return;
    }
    const idx = tabIndexFromEvent(e);
    if (idx !== null) {
      consume(e);
      nav.selectByIndex(idx);
      return;
    }
    if (Keymap.cycleNext.match(e)) {
      consume(e);
      nav.cycleNext();
      return;
    }
    if (Keymap.cyclePrev.match(e)) {
      consume(e);
      nav.cyclePrev();
      return;
    }
  }
</script>

<ModeWatcher defaultMode="dark" />

<div class="flex h-full flex-col overflow-hidden">
  <header
    class="flex h-7 flex-shrink-0 items-center border-b border-border bg-card pl-3 select-none"
    style="-webkit-app-region: drag"
  >
    <img src={appIconUrl} alt="" class="mr-1.5 size-3.5 flex-none" draggable="false" />
    <span class="text-[11px] tracking-wider text-muted-foreground">Soloe</span>
    <div class="flex-1 self-stretch" aria-hidden="true"></div>
    <div class="flex self-stretch" style="-webkit-app-region: no-drag">
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={() => settings.openDialog()}
        aria-label="Settings"
        title="Settings (Ctrl+,)"
      >
        <Settings class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={() => ipc.window.minimize()}
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={() => ipc.window.toggleMaximize()}
        aria-label="Maximize"
        title="Maximize"
      >
        <Maximize2 class="size-3" />
      </Button>
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
        onclick={() => ipc.window.close()}
        aria-label="Close"
        title="Close"
      >
        <X class="size-3.5" />
      </Button>
    </div>
  </header>
  <div class="relative flex min-h-0 flex-1">
    {#if !sidebar.hidden}
      <Sidebar />
    {:else}
      <button
        type="button"
        class="absolute top-2 left-2 z-20 flex size-7 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Show sidebar"
        title="Show sidebar (Ctrl+B)"
        onclick={() => sidebar.show()}
      >
        <PanelLeftOpen class="size-4" />
      </button>
    {/if}
    <!-- Stays mounted across fullscreen toggles so xterm doesn't re-attach. -->
    <div class={railFullscreen ? 'hidden' : 'contents'}>
      <TerminalArea />
    </div>
    <RightRail fullscreen={railFullscreen} />
  </div>
  <NewSessionModal />
  <ProjectModal />
  <CommandPalette />
  <FilePalette />
  <NewSessionPickerDialog />
  <SessionHandoffDialog />
  <ConfirmDialog />
  <AgentIntegrationSetupDialog />
  <SettingsDialog />
  <AgentNotificationToasts />
  <Toaster richColors closeButton />
</div>
