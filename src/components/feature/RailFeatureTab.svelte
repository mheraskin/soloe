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
  import {
    createFeatureScope,
    featuresStore,
    type FeatureScope
  } from '../../stores/features.svelte';
  import { createFilesScope, filesStore } from '../../stores/files.svelte';
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
  let activeScope = $derived.by<FeatureScope | null>(() => {
    if (!activeCwd || !selected) return null;
    return createFeatureScope(activeCwd, {
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    });
  });

  let state = $derived(featuresStore.stateFor(activeScope));
  let snapshot = $derived(state?.snapshot ?? null);
  let selectedSlug = $derived(featuresStore.selectedSlugFor(activeScope));

  $effect(() => {
    const scope = activeScope;
    if (!scope) return;
    void featuresStore.refresh(scope).catch(reportError);
  });

  // Subscribe to the main-process watcher for the active worktree; cleanup
  // unsubscribes on cwd switch or component teardown. The store ref-counts
  // subscribers per cwd, so concurrent visibility from another mount point
  // doesn't drop the watcher when this effect re-runs.
  $effect(() => {
    const scope = activeScope;
    if (!scope) return;
    let owned = false;
    const syncSubscription = () => {
      if (!document.hidden && !owned) {
        owned = true;
        void featuresStore.subscribe(scope).catch(() => undefined);
      } else if (document.hidden && owned) {
        owned = false;
        void featuresStore.unsubscribe(scope).catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', syncSubscription);
    syncSubscription();
    return () => {
      document.removeEventListener('visibilitychange', syncSubscription);
      if (owned) {
        owned = false;
        void featuresStore.unsubscribe(scope).catch(() => undefined);
      }
    };
  });

  function onPickSlug(slug: string | null): void {
    if (!activeScope) return;
    featuresStore.setSelectedSlug(activeScope, slug);
  }

  function onOpenFile(relativePath: string): void {
    if (!activeCwd || !activeScope) return;
    const filesScope = createFilesScope(activeCwd, {
      runMode: activeScope.runMode,
      ...(activeScope.wslDistro ? { wslDistro: activeScope.wslDistro } : {})
    });
    const current = filesStore.openFileFor(filesScope);
    const discardingDirty = Boolean(
      current
      && current.relativePath !== relativePath
      && filesStore.dirtyFor(filesScope)
    );
    if (discardingDirty && !window.confirm('Discard unsaved changes and open this file?')) return;
    void filesStore
      .openFileAt(filesScope, relativePath, { discardDirty: discardingDirty })
      .then((opened) => {
        if (opened) rightRail.openTab('files');
      })
      .catch(reportError);
  }

  function onToggleBranch(branchId: string, next: BranchStatus): void {
    if (!activeScope) return;
    void featuresStore.setBranchStatus(activeScope, branchId, next).catch(reportError);
  }

  async function onSetIssueStatus(relativePath: string, status: string): Promise<void> {
    if (!activeScope) return;
    await featuresStore.setIssueStatus(activeScope, relativePath, status);
  }

  function onRefresh(): void {
    if (!activeScope) return;
    void featuresStore.refresh(activeScope).catch(reportError);
  }

  onMount(() => {
    const onRefocus = () => {
      if (rightRail.activeTab !== 'feature') return;
      document.querySelector<HTMLElement>('[data-feature-picker-trigger]')?.focus();
    };
    const onFocusPane = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId: string }>).detail;
      if (detail?.tabId !== 'feature') return;
      document.querySelector<HTMLElement>('[data-feature-picker-trigger]')?.focus();
    };
    window.addEventListener('soloe:refocus-rail', onRefocus);
    window.addEventListener('soloe:focus-pane', onFocusPane);
    return () => {
      window.removeEventListener('soloe:refocus-rail', onRefocus);
      window.removeEventListener('soloe:focus-pane', onFocusPane);
    };
  });
</script>

<div class="mobile-feature-surface flex min-h-0 min-w-0 flex-1 flex-col">
  <header class="mobile-rail-header flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
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
                scope={activeScope!}
                coverage={snapshot.coverage}
                onToggleBranch={onToggleBranch}
                onOpenFile={onOpenFile}
              />
            {/if}
            <PlansSection scope={activeScope!} plans={snapshot.plans} onOpenFile={onOpenFile} />
            <IssuesSection
              scope={activeScope!}
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
