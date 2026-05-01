<script lang="ts">
  import { onMount } from 'svelte';
  import { sessions } from './stores/sessions.svelte';
  import { settings } from './stores/settings.svelte';
  import { projects } from './stores/projects.svelte';
  import { reportError } from './stores/toast.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import TerminalArea from './components/TerminalArea.svelte';
  import AgentInspector from './components/AgentInspector.svelte';
  import NewSessionModal from './components/NewSessionModal.svelte';
  import Toast from './components/Toast.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import SettingsDrawer from './components/SettingsDrawer.svelte';
  import ProjectModal from './components/ProjectModal.svelte';

  onMount(() => {
    sessions.attachListeners();
    sessions.load().catch(reportError);
    settings.attachListeners();
    settings.load().catch(reportError);
    projects.attachListeners();
    projects.load().catch(reportError);
    return () => {
      sessions.detach();
      settings.detach();
      projects.detach();
    };
  });
</script>

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
  <ConfirmDialog />
  <SettingsDrawer />
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
