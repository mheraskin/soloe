<script lang="ts">
  import {
    AlertCircle,
    Loader2,
    Maximize2,
    Minimize2,
    RefreshCw,
    Microscope
  } from '@lucide/svelte';
  import type { BranchStatus } from '@shared/types/features.js';
  import { onMount } from 'svelte';
  import { sessions } from '../../stores/sessions.svelte';
  import { featuresStore, type FeatureContext } from '../../stores/features.svelte';
  import { filesStore } from '../../stores/files.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import FeaturePicker from './FeaturePicker.svelte';
  import FeatureHero from './FeatureHero.svelte';
  import CoverageMapSection from './CoverageMapSection.svelte';
  import PlansSection from './PlansSection.svelte';
  import IssuesSection from './IssuesSection.svelte';
  import SetupCta from './SetupCta.svelte';

  let selected = $derived(sessions.selected);
  let activeCwd = $derived.by<string | null>(() => {
    const cwd = selected?.cwd?.trim();
    return cwd && cwd.length > 0 ? cwd : null;
  });
  let activeContext = $derived.by<(FeatureContext & { cwd: string }) | null>(() => {
    if (!activeCwd || !selected) return null;
    return {
      cwd: activeCwd,
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    };
  });

  let state = $derived(activeCwd ? featuresStore.stateFor(activeCwd) : null);
  let snapshot = $derived(state?.snapshot ?? null);
  let selectedSlug = $derived(activeCwd ? featuresStore.selectedSlugFor(activeCwd) : null);

  $effect(() => {
    if (!activeContext) return;
    featuresStore.setContext(activeContext.cwd, {
      runMode: activeContext.runMode,
      ...(activeContext.wslDistro ? { wslDistro: activeContext.wslDistro } : {})
    });
  });

  $effect(() => {
    if (!activeContext) return;
    void featuresStore.refresh(activeContext.cwd).catch(reportError);
  });

  // Subscribe to the main-process watcher for the active worktree; cleanup
  // unsubscribes on cwd switch or component teardown. The store ref-counts
  // subscribers per cwd, so concurrent visibility from another mount point
  // doesn't drop the watcher when this effect re-runs.
  $effect(() => {
    if (!activeContext) return;
    const cwd = activeContext.cwd;
    void featuresStore.subscribe(cwd).catch(() => undefined);
    return () => {
      void featuresStore.unsubscribe(cwd).catch(() => undefined);
    };
  });

  function onPickSlug(slug: string | null): void {
    if (!activeCwd) return;
    featuresStore.setSelectedSlug(activeCwd, slug);
  }

  function onOpenFile(relativePath: string): void {
    if (!activeCwd || !activeContext) return;
    filesStore.setContext(activeCwd, {
      runMode: activeContext.runMode,
      ...(activeContext.wslDistro ? { wslDistro: activeContext.wslDistro } : {})
    });
    void filesStore
      .openFileAt(activeCwd, relativePath)
      .then(() => rightRail.openTab('files'))
      .catch(reportError);
  }

  function onToggleBranch(branchId: string, next: BranchStatus): void {
    if (!activeCwd) return;
    void featuresStore.setBranchStatus(activeCwd, branchId, next).catch(reportError);
  }

  async function onSetIssueStatus(relativePath: string, status: string): Promise<void> {
    if (!activeCwd) return;
    await featuresStore.setIssueStatus(activeCwd, relativePath, status);
  }

  function onRefresh(): void {
    if (!activeCwd) return;
    void featuresStore.refresh(activeCwd).catch(reportError);
  }

  onMount(() => {
    const onRefocus = () => {
      if (rightRail.activeTab !== 'feature') return;
      document.querySelector<HTMLElement>('[data-feature-picker-trigger]')?.focus();
    };
    window.addEventListener('soloe:refocus-rail', onRefocus);
    return () => window.removeEventListener('soloe:refocus-rail', onRefocus);
  });
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
  <header class="flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
    <div class="flex min-w-0 items-center gap-1.5">
      <Microscope class="size-3.5 text-muted-foreground" />
      <span class="text-[10px] font-medium tracking-wider uppercase text-muted-foreground">Feature Lab</span>
    </div>
    <div class="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        onclick={onRefresh}
        disabled={!activeCwd || state?.loading}
        aria-label="Refresh feature snapshot"
        title="Refresh"
      >
        {#if state?.loading}
          <Loader2 class="size-3 animate-spin" />
        {:else}
          <RefreshCw class="size-3" />
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onclick={() => rightRail.toggleFullscreen()}
        aria-label={rightRail.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        title={rightRail.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
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

  {#if !activeCwd}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      <Microscope class="size-6 text-muted-foreground/50" />
      <span class="text-xs text-muted-foreground">
        Select a session to inspect its features.
      </span>
    </div>
  {:else if state?.error && !snapshot}
    <div class="flex flex-col items-center justify-center gap-2 px-3 py-6 text-center text-xs text-destructive">
      <AlertCircle class="size-4" />
      <span>{state.error}</span>
      <Button variant="outline" size="xs" onclick={onRefresh}>Retry</Button>
    </div>
  {:else if !snapshot}
    <div class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
      <Loader2 class="mr-2 size-3 animate-spin" />
      Scanning…
    </div>
  {:else}
    <ScrollArea class="min-h-0 flex-1">
      <div class="flex flex-col gap-2 p-2.5">
        <FeaturePicker
          features={snapshot.features}
          value={selectedSlug}
          onSelect={onPickSlug}
        />

        {#if !snapshot.setup.hasAgentSkillsBlock}
          <SetupCta
            cwd={activeCwd}
            projectId={selected?.projectId ?? null}
            branch={selected?.lastBranch ?? null}
          />
        {/if}

        {#if selectedSlug}
          {#key activeCwd + ':' + selectedSlug}
            <FeatureHero
              slug={selectedSlug}
              snapshot={snapshot}
              onOpenFile={onOpenFile}
            />
            {#if snapshot.coverage}
              <CoverageMapSection
                cwd={activeCwd}
                coverage={snapshot.coverage}
                onToggleBranch={onToggleBranch}
                onOpenFile={onOpenFile}
              />
            {/if}
            <PlansSection cwd={activeCwd} plans={snapshot.plans} onOpenFile={onOpenFile} />
            <IssuesSection
              cwd={activeCwd}
              issues={snapshot.issues}
              tracker={snapshot.tracker}
              onOpenFile={onOpenFile}
              onSetStatus={onSetIssueStatus}
            />
          {/key}
        {:else if snapshot.features.length === 0}
          <div class="flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-3 py-6 text-center">
            <Microscope class="size-5 text-muted-foreground/50" />
            <div class="flex flex-col gap-1">
              <span class="text-xs font-medium text-foreground">No features yet</span>
              <span class="text-[11px] leading-snug text-muted-foreground">
                Run <span class="font-mono">/grill-with-docs</span> in a session to seed
                <span class="font-mono">docs/grill/&lt;slug&gt;/</span>,
                <span class="font-mono">docs/plans/</span>, and
                <span class="font-mono">.scratch/&lt;slug&gt;/</span> for this worktree.
              </span>
            </div>
          </div>
        {:else}
          <div class="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
            Pick a feature above to inspect its coverage map, plans, and issues.
          </div>
        {/if}

        {#if state?.error && snapshot}
          <div class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
            <AlertCircle class="mt-0.5 size-3 shrink-0" />
            <span class="min-w-0 flex-1">{state.error}</span>
          </div>
        {/if}
      </div>
    </ScrollArea>
  {/if}
</div>
