<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ModeWatcher, setMode } from 'mode-watcher';
  import { FolderOpen, Maximize2, Minus, Plus, Search, Settings, X } from '@lucide/svelte';
  import { sessions } from './stores/sessions.svelte';
  import { settings } from './stores/settings.svelte';
  import { projects } from './stores/projects.svelte';
  import { git } from './stores/git.svelte';
  import { nav } from './stores/nav.svelte';
  import { commandPalette } from './stores/command-palette.svelte';
  import { filePalette } from './stores/file-palette.svelte';
  import { reportError } from './stores/toast.svelte';
  import { ipc } from './lib/ipc';
  import { agentIntegrationSetup } from './stores/agent-integration-setup.svelte';
  import { Keymap, projectIndexFromEvent, tabIndexFromEvent } from './lib/keymap';
  import { kbdHints } from './stores/kbd-hints.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Kbd } from '$lib/components/ui/kbd';
  import { Toaster } from '$lib/components/ui/sonner';
  import Sidebar from './components/Sidebar.svelte';
  import TerminalArea from './components/TerminalArea.svelte';
  import RightRail from './components/RightRail.svelte';
  import NewSessionModal from './components/NewSessionModal.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import SettingsDrawer from './components/SettingsDrawer.svelte';
  import ProjectModal from './components/ProjectModal.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import FilePalette from './components/FilePalette.svelte';
  import AgentIntegrationSetupDialog from './components/AgentIntegrationSetupDialog.svelte';

  let appliedTheme: string | null = null;

  onMount(() => {
    sessions.attachListeners();
    settings.attachListeners();
    projects.attachListeners();
    git.attachListeners();
    void loadInitialState();
    const detachKbdHints = kbdHints.attach();
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      detachKbdHints();
      sessions.detach();
      settings.detach();
      projects.detach();
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

  function consume(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function newSessionFromSelection(): void {
    const sel = sessions.selected;
    void sessions
      .createWithDefaults({
        ...(sel?.projectId ? { projectId: sel.projectId } : {}),
        ...(sel?.cwd ? { cwd: sel.cwd } : {})
      })
      .catch(reportError);
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
      settings.toggleDrawer();
      return;
    }
    if (Keymap.openProject.match(e)) {
      consume(e);
      commandPalette.open('open-project');
      return;
    }
    if (Keymap.newSession.match(e)) {
      consume(e);
      newSessionFromSelection();
      return;
    }
    if (Keymap.terminalFind.match(e)) {
      consume(e);
      window.dispatchEvent(new CustomEvent('soloe:terminal-find'));
      return;
    }
    if (Keymap.zoomIn.match(e)) {
      consume(e);
      void ipc.window.zoomIn().catch(reportError);
      return;
    }
    if (Keymap.zoomOut.match(e)) {
      consume(e);
      void ipc.window.zoomOut().catch(reportError);
      return;
    }
    if (commandPalette.isOpen || filePalette.open) return;
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
    if (Keymap.closeActiveTab.match(e)) {
      consume(e);
      void nav.closeActive();
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
    class="flex h-8 flex-shrink-0 items-center gap-1.5 border-b border-border bg-card pl-3 select-none"
    style="-webkit-app-region: drag"
  >
    <span class="text-[11px] tracking-wider text-muted-foreground">Soloe</span>
    <div class="flex items-center gap-0.5" style="-webkit-app-region: no-drag">
      <Button
        variant="ghost"
        size="icon-sm"
        class="size-6 text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={() => commandPalette.open('open-project')}
        aria-label="Open project"
        title="Open project (Ctrl+Shift+O)"
      >
        <FolderOpen class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        class="size-6 text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={newSessionFromSelection}
        aria-label="New session"
        title="New session (Ctrl+T)"
      >
        <Plus class="size-3.5" />
      </Button>
    </div>
    <div class="flex flex-1 justify-center self-stretch px-2 py-1">
      <button
        type="button"
        class="group flex h-full w-full max-w-md items-center gap-2 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style="-webkit-app-region: no-drag"
        onclick={() => commandPalette.toggle()}
        aria-label="Open command palette"
        title="Search or run command (Ctrl+K)"
      >
        <Search class="size-3.5 shrink-0 opacity-70 group-hover:opacity-100" />
        <span class="flex-1 truncate text-left">Search or run command</span>
        <Kbd keys={['Ctrl', 'K']} class="opacity-80" />
      </button>
    </div>
    <div class="flex self-stretch" style="-webkit-app-region: no-drag">
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={() => settings.openDrawer()}
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
  <div class="flex min-h-0 flex-1">
    <Sidebar />
    <TerminalArea />
    <RightRail />
  </div>
  <NewSessionModal />
  <ProjectModal />
  <CommandPalette />
  <FilePalette />
  <ConfirmDialog />
  <AgentIntegrationSetupDialog />
  <SettingsDrawer />
  <Toaster richColors closeButton />
</div>
