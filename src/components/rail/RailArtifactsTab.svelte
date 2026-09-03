<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ArrowLeft,
    Home,
    Loader2,
    RefreshCw,
    Trash2,
    LibraryBig
  } from '@lucide/svelte';
  import type { ArtifactProjectRef } from '@shared/types/artifacts.js';
  import { artifacts } from '../../stores/artifacts.svelte';
  import { projects } from '../../stores/projects.svelte';
  import { deviceSessions } from '../../stores/device-sessions.svelte';
  import { confirmStore } from '../../stores/confirm.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { parseArtifactFrameMessage } from '../../lib/artifact-frame-messages';
  import { Button } from '$lib/components/ui/button';

  let frame: HTMLIFrameElement | null = $state(null);
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
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
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

<section class="flex h-full min-h-0 flex-col bg-background" aria-label="Artifacts">
  <header class="flex h-11 flex-none items-center gap-1 border-b border-border px-2">
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={goBack}
      disabled={!activeProject || loading}
      aria-label="Back"
      title="Back"
    >
      <ArrowLeft />
    </Button>
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={goHome}
      disabled={!snapshot?.homeArtifactId || loading}
      aria-label="Artifact home"
      title="Artifact home"
    >
      <Home />
    </Button>
    <div class="min-w-0 flex-1 px-2">
      <p class="truncate text-sm font-medium">{document?.title ?? 'Artifacts'}</p>
      {#if document && !document.isHome}
        <p class="truncate text-[11px] text-muted-foreground">{document.description}</p>
      {/if}
    </div>
    <Button
      variant="ghost"
      size="icon-sm"
      onclick={refresh}
      disabled={!activeProject || loading}
      aria-label="Refresh artifacts"
      title="Refresh"
    >
      <RefreshCw class={loading ? 'animate-spin' : undefined} />
    </Button>
    {#if canDelete}
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-destructive"
        onclick={deleteCurrent}
        aria-label="Delete current artifact"
        title="Delete artifact"
      >
        <Trash2 />
      </Button>
    {/if}
  </header>

  <div class="relative min-h-0 flex-1 bg-muted/20">
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
        class="h-full w-full border-0 bg-white"
        title={document.title}
        sandbox="allow-scripts"
        srcdoc={document.html}
      ></iframe>
    {/if}
  </div>
</section>
