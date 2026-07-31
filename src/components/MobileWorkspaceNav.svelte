<script lang="ts">
  import {
    FolderTree,
    GitCompare,
    Globe,
    Microscope,
    NotebookPen
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { rightRail, type RailTabId } from '../stores/right-rail.svelte';
  import { supportsBackendOperation } from '../lib/ipc';

  export type MobileWorkspacePage = 'navigation' | 'terminal' | 'pane';

  interface Props {
    page: MobileWorkspacePage;
    onNavigate: (page: MobileWorkspacePage) => void;
  }

  interface PaneDestination {
    id: RailTabId;
    label: string;
    icon: Component<any, {}, ''>;
  }

  let { page, onNavigate }: Props = $props();

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
    onNavigate('pane');
    window.dispatchEvent(new CustomEvent('soloe:focus-pane', { detail: { tab } }));
  }
</script>

<div class="mobile-workspace-dock">
  <nav class="mobile-pane-destinations" aria-label="Open a pane">
    {#each panes as pane (pane.id)}
      {@const active = rightRail.openTabs.includes(pane.id)}
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
      class:active={page === 'terminal'}
      onclick={() => onNavigate('terminal')}
      aria-label="Terminal"
      aria-current={page === 'terminal' ? 'page' : undefined}
    >
      <span></span>
    </button>
    <button
      type="button"
      class:active={page === 'pane'}
      class:available={rightRail.open}
      disabled={!rightRail.open}
      onclick={() => onNavigate('pane')}
      aria-label={rightRail.open ? 'Open pane' : 'No pane open'}
      aria-current={page === 'pane' ? 'page' : undefined}
    >
      <span></span>
    </button>
  </nav>
</div>
