<script lang="ts">
  import {
    FolderTree,
    GitCompare,
    Globe,
    Microscope,
    NotebookPen,
    TerminalSquare
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { rightRail, type RailTabId } from '../stores/right-rail.svelte';
  import { supportsBackendOperation } from '../lib/ipc';

  export type MobileWorkspacePage = 'navigation' | 'workspace';
  export type MobileWorkspaceMode = 'terminal' | 'pane';

  interface Props {
    page: MobileWorkspacePage;
    mode: MobileWorkspaceMode;
    onNavigate: (page: MobileWorkspacePage) => void;
    onSelectMode: (mode: MobileWorkspaceMode) => void;
  }

  interface PaneDestination {
    id: RailTabId;
    label: string;
    icon: Component<any, {}, ''>;
  }

  let { page, mode, onNavigate, onSelectMode }: Props = $props();

  const browserPaneAvailable = supportsBackendOperation('browser', 'openDevTools');
  const panes: PaneDestination[] = [
    { id: 'diff', label: 'Working diff', icon: GitCompare },
    { id: 'files', label: 'Files', icon: FolderTree },
    { id: 'feature', label: 'Feature Lab', icon: Microscope },
    ...(browserPaneAvailable
      ? [{ id: 'browser' as const, label: 'Browser', icon: Globe }]
      : []),
    { id: 'notes', label: 'Notes', icon: NotebookPen }
  ];

  function openPane(tab: RailTabId): void {
    rightRail.openTab(tab);
    onSelectMode('pane');
    onNavigate('workspace');
    window.dispatchEvent(new CustomEvent('soloe:focus-pane', { detail: { tab } }));
  }
</script>

<div class="mobile-workspace-dock">
  <nav class="mobile-pane-destinations" aria-label="Workspace tools">
    {#each panes as pane, index (pane.id)}
      {#if index === 2}
        <button
          type="button"
          class="mobile-pane-destination mobile-terminal-destination"
          class:active={mode === 'terminal'}
          onclick={() => {
            onSelectMode('terminal');
            onNavigate('workspace');
          }}
          aria-label="Terminal"
          aria-pressed={mode === 'terminal'}
          title="Terminal"
        >
          <TerminalSquare class="size-[1.125rem]" />
        </button>
      {/if}
      {@const active = mode === 'pane' && rightRail.openTabs.includes(pane.id)}
      <button
        type="button"
        class="mobile-pane-destination"
        class:active
        onclick={() => openPane(pane.id)}
        aria-label={pane.label}
        aria-pressed={active}
        title={pane.label}
      >
        <pane.icon class="size-[1.125rem]" />
      </button>
    {/each}
    {#if panes.length < 3}
      <button
        type="button"
        class="mobile-pane-destination mobile-terminal-destination"
        class:active={mode === 'terminal'}
        onclick={() => {
          onSelectMode('terminal');
          onNavigate('workspace');
        }}
        aria-label="Terminal"
        aria-pressed={mode === 'terminal'}
        title="Terminal"
      >
        <TerminalSquare class="size-[1.125rem]" />
      </button>
    {/if}
  </nav>

  <nav class="mobile-page-indicator" aria-label="Workspace pages">
    <button
      type="button"
      class:active={page === 'navigation'}
      onclick={() => onNavigate('navigation')}
      aria-label="Session list"
      aria-current={page === 'navigation' ? 'page' : undefined}
    >
      <span></span>
    </button>
    <button
      type="button"
      class:active={page === 'workspace'}
      onclick={() => onNavigate('workspace')}
      aria-label="Workspace"
      aria-current={page === 'workspace' ? 'page' : undefined}
    >
      <span></span>
    </button>
  </nav>
</div>
