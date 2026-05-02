<script lang="ts">
  import { onMount } from 'svelte';
  import { ModeWatcher, setMode } from 'mode-watcher';
  import { Maximize2, Minus, X } from '@lucide/svelte';
  import { sessions } from './stores/sessions.svelte';
  import { settings } from './stores/settings.svelte';
  import { projects } from './stores/projects.svelte';
  import { git } from './stores/git.svelte';
  import { nav } from './stores/nav.svelte';
  import { commandPalette } from './stores/command-palette.svelte';
  import { filePalette } from './stores/file-palette.svelte';
  import { reportError } from './stores/toast.svelte';
  import { ipc } from './lib/ipc';
  import { Keymap, tabIndexFromEvent } from './lib/keymap';
  import { Button } from '$lib/components/ui/button';
  import { Toaster } from '$lib/components/ui/sonner';
  import Sidebar from './components/Sidebar.svelte';
  import TerminalArea from './components/TerminalArea.svelte';
  import AgentInspector from './components/AgentInspector.svelte';
  import NewSessionModal from './components/NewSessionModal.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import SettingsDrawer from './components/SettingsDrawer.svelte';
  import ProjectModal from './components/ProjectModal.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import FilePalette from './components/FilePalette.svelte';
  import DiagnosticsPane from './components/DiagnosticsPane.svelte';

  onMount(() => {
    sessions.attachListeners();
    sessions.load().catch(reportError);
    settings.attachListeners();
    settings.load().catch(reportError);
    projects.attachListeners();
    projects.load().catch(reportError);
    git.attachListeners();
    return () => {
      sessions.detach();
      settings.detach();
      projects.detach();
      git.detach();
    };
  });

  $effect(() => {
    setMode(settings.current.appearance.theme);
  });

  function onKey(e: KeyboardEvent) {
    if (Keymap.commandPalette.match(e)) {
      e.preventDefault();
      commandPalette.toggle();
      return;
    }
    if (Keymap.filePalette.match(e)) {
      e.preventDefault();
      filePalette.toggle();
      return;
    }
    if (Keymap.terminalFind.match(e)) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('soloe:terminal-find'));
      return;
    }
    if (Keymap.zoomIn.match(e)) {
      e.preventDefault();
      void ipc.window.zoomIn().catch(reportError);
      return;
    }
    if (Keymap.zoomOut.match(e)) {
      e.preventDefault();
      void ipc.window.zoomOut().catch(reportError);
      return;
    }
    if (commandPalette.isOpen || filePalette.open) return;
    const idx = tabIndexFromEvent(e);
    if (idx !== null) {
      e.preventDefault();
      nav.selectByIndex(idx);
      return;
    }
    if (Keymap.closeActiveTab.match(e)) {
      e.preventDefault();
      void nav.closeActive();
      return;
    }
    if (Keymap.cycleNext.match(e)) {
      e.preventDefault();
      nav.cycleNext();
      return;
    }
    if (Keymap.cyclePrev.match(e)) {
      e.preventDefault();
      nav.cyclePrev();
      return;
    }
  }
</script>

<svelte:window onkeydown={onKey} />
<ModeWatcher defaultMode="dark" />

<div class="flex h-full flex-col overflow-hidden">
  <header
    class="flex h-7 flex-shrink-0 items-center border-b border-border bg-card pl-3 select-none"
    style="-webkit-app-region: drag"
  >
    <span class="text-[11px] tracking-wider text-muted-foreground">Soloe</span>
    <div class="flex-1 self-stretch" aria-hidden="true"></div>
    <div class="flex self-stretch" style="-webkit-app-region: no-drag">
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
    <AgentInspector />
  </div>
  <NewSessionModal />
  <ProjectModal />
  <CommandPalette />
  <FilePalette />
  <ConfirmDialog />
  <SettingsDrawer />
  <DiagnosticsPane />
  <Toaster richColors closeButton />
</div>
