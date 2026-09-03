<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ArrowLeft,
    Home,
    Loader2,
    Maximize2,
    Minimize2,
    RefreshCw,
    Trash2,
    LibraryBig
  } from '@lucide/svelte';
  import type { ArtifactProjectRef } from '@shared/types/artifacts.js';
  import { artifacts } from '../../stores/artifacts.svelte';
  import { projects } from '../../stores/projects.svelte';
  import { deviceSessions } from '../../stores/device-sessions.svelte';
  import { confirmStore } from '../../stores/confirm.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { parseArtifactFrameMessage } from '../../lib/artifact-frame-messages';
  import { Button } from '$lib/components/ui/button';

  let frame: HTMLIFrameElement | null = $state(null);
  let root: HTMLElement | null = $state(null);
  let activeProjectId = $derived(deviceSessions.activeSession?.projectId ?? null);
  let activeProject = $derived.by<ArtifactProjectRef | null>(() => {
    if (!activeProjectId) return null;
    const local = projects.get(activeProjectId);
    return {
      id: activeProjectId,
      name: local?.name ?? deviceSessions.activeProject?.name ?? 'Project'
    };
  });
  let route = $derived(
    deviceSessions.activeRemoteDeviceId
      ? { deviceId: deviceSessions.activeRemoteDeviceId }
      : undefined
  );
  let snapshot = $derived(
    activeProjectId ? artifacts.snapshotsByProject[activeProjectId] : undefined
  );
  let document = $derived(
    activeProjectId ? artifacts.documentsByProject[activeProjectId] : undefined
  );
  let loading = $derived(
    activeProjectId ? artifacts.loadingByProject[activeProjectId] === true : false
  );
  let error = $derived(
    activeProjectId ? artifacts.errorByProject[activeProjectId] ?? null : null
  );
  let canDelete = $derived(Boolean(document && document.homeOwnership !== 'system'));

  $effect(() => {
    const project = activeProject;
    if (!project) return;
    void artifacts.ensureCatalog(project, route)
      .then(() => {
        if (!artifacts.documentsByProject[project.id]) {
          return artifacts.openHome(project, route);
        }
      })
      .catch(() => undefined);
  });

  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const message = parseArtifactFrameMessage(event.data);
      const project = activeProject;
      if (!message || !project) return;
      const member = artifacts.snapshotsByProject[project.id]?.artifacts
        .find((artifact) => artifact.id === message.artifactId);
      if (!member) return;
      if (message.action === 'open') {
        void artifacts.openArtifact(project, message.artifactId, route).catch(reportError);
        return;
      }
      void confirmAndDelete(project, message.artifactId, member.title);
    };
    const focusContent = () => (frame ?? root)?.focus();
    const onRefocus = () => {
      if (rightRail.activeTab === 'artifacts') focusContent();
    };
    const onFocusPane = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        typeof detail !== 'object'
        || detail === null
        || !('tabId' in detail)
        || detail.tabId !== 'artifacts'
      ) return;
      focusContent();
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('soloe:refocus-rail', onRefocus);
    window.addEventListener('soloe:focus-pane', onFocusPane);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('soloe:refocus-rail', onRefocus);
      window.removeEventListener('soloe:focus-pane', onFocusPane);
    };
  });

  function goHome(): void {
    if (!activeProject) return;
    void artifacts.openHome(activeProject, route).catch(reportError);
  }

  function goBack(): void {
    if (!activeProject) return;
    void artifacts.back(activeProject, route).catch(reportError);
  }

  function refresh(): void {
    if (!activeProject) return;
    void artifacts.refresh(activeProject, route).catch(reportError);
  }

  function deleteCurrent(): void {
    if (!activeProject || !document || !canDelete) return;
    void confirmAndDelete(activeProject, document.id, document.title);
  }

  async function confirmAndDelete(
    project: ArtifactProjectRef,
    artifactId: string,
    title: string
  ): Promise<void> {
    const confirmed = await confirmStore.ask({
      title: 'Delete artifact?',
      message: `Delete “${title}” from this Project? This removes its saved HTML from Soloe.`,
      confirmLabel: 'Delete',
      tone: 'danger'
    });
    if (!confirmed) return;
    try {
      await artifacts.delete(project, artifactId, route);
    } catch (deleteError) {
      reportError(deleteError);
    }
  }
</script>

<section
  bind:this={root}
  class="mobile-artifacts-surface flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background outline-none"
  aria-label="Artifacts"
  tabindex="-1"
>
  <header class="mobile-rail-header soloe-pane-header min-w-0 justify-between">
    <div class="flex min-w-0 flex-1 items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        onclick={goBack}
        disabled={!activeProject || loading}
        aria-label="Back"
        title="Back"
      >
        <ArrowLeft class="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onclick={goHome}
        disabled={!snapshot?.homeArtifactId || loading}
        aria-label="Artifact home"
        title="Artifact home"
      >
        <Home class="size-3" />
      </Button>
      <div class="flex min-w-0 items-center gap-1.5 px-1">
        <span class="shrink-0 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          Artifacts
        </span>
        <span class="text-muted-foreground/35" aria-hidden="true">·</span>
        <span class="truncate text-[11px] text-foreground" title={document?.title ?? 'Artifacts'}>
          {document?.title ?? activeProject?.name ?? 'No project selected'}
        </span>
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        onclick={refresh}
        disabled={!activeProject || loading}
        aria-label="Refresh artifacts"
        title="Refresh"
      >
        <RefreshCw class={loading ? 'size-3 animate-spin' : 'size-3'} />
      </Button>
      {#if canDelete}
        <Button
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground hover:text-destructive"
          onclick={deleteCurrent}
          aria-label="Delete current artifact"
          title="Delete artifact"
        >
          <Trash2 class="size-3" />
        </Button>
      {/if}
      <Button
        variant="ghost"
        size="icon-xs"
        onclick={() => rightRail.toggleFullscreen()}
        aria-label={rightRail.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        title={rightRail.fullscreen ? 'Exit fullscreen (Ctrl+Shift+M)' : 'Fullscreen (Ctrl+Shift+M)'}
        aria-pressed={rightRail.fullscreen}
      >
        {#if rightRail.fullscreen}
          <Minimize2 class="size-3" />
        {:else}
          <Maximize2 class="size-3" />
        {/if}
      </Button>
    </div>
  </header>

  <div class="relative min-h-0 flex-1 bg-background">
    {#if !activeProject}
      <div class="flex h-full flex-col items-center justify-center px-8 text-center">
        <LibraryBig class="mb-3 size-8 text-muted-foreground/60" />
        <h2 class="text-sm font-medium">No Project selected</h2>
        <p class="mt-1 max-w-sm text-xs text-muted-foreground">
          Select a Project session to browse its artifacts.
        </p>
      </div>
    {:else if loading && !document}
      <div class="flex h-full items-center justify-center text-muted-foreground" aria-label="Loading artifacts">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if error && !document}
      <div class="flex h-full flex-col items-center justify-center px-8 text-center">
        <LibraryBig class="mb-3 size-8 text-muted-foreground/60" />
        <h2 class="text-sm font-medium">Artifacts could not be loaded</h2>
        <p class="mt-1 max-w-md text-xs text-muted-foreground">{error}</p>
        <Button class="mt-4" variant="outline" size="sm" onclick={refresh}>Try again</Button>
      </div>
    {:else if !snapshot?.homeArtifactId}
      <div class="flex h-full flex-col items-center justify-center px-8 text-center">
        <LibraryBig class="mb-3 size-8 text-muted-foreground/60" />
        <h2 class="text-sm font-medium">No artifacts yet</h2>
        <p class="mt-1 max-w-sm text-xs text-muted-foreground">
          Published HTML reports and project documents will appear here.
        </p>
      </div>
    {:else if document}
      <iframe
        bind:this={frame}
        class="h-full w-full border-0 bg-background"
        title={document.title}
        sandbox="allow-scripts"
        srcdoc={document.html}
      ></iframe>
    {/if}
  </div>
</section>
