<script lang="ts">
  import { onMount } from 'svelte';
  import { sessions } from './stores/sessions.svelte';
  import { settings } from './stores/settings.svelte';
  import { projects } from './stores/projects.svelte';
  import { git } from './stores/git.svelte';
  import { nav } from './stores/nav.svelte';
  import { commandPalette } from './stores/command-palette.svelte';
  import { filePalette } from './stores/file-palette.svelte';
  import { reportError } from './stores/toast.svelte';
  import { Keymap, tabIndexFromEvent } from './lib/keymap';
  import Sidebar from './components/Sidebar.svelte';
  import TerminalArea from './components/TerminalArea.svelte';
  import AgentInspector from './components/AgentInspector.svelte';
  import NewSessionModal from './components/NewSessionModal.svelte';
  import Toast from './components/Toast.svelte';
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
    if (commandPalette.open || filePalette.open) return;
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

<div class="app">
  <header class="titlebar">
    <span class="title">Soloe</span>
  </header>
  <div class="body">
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
  <Toast />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .titlebar {
    -webkit-app-region: drag;
    height: 28px;
    background: var(--bg-elev-1);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 12px;
    flex-shrink: 0;
  }
  .title {
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.04em;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
</style>
