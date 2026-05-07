<script lang="ts">
  import {
    GitCompare,
    Loader2,
    AlertCircle,
    RefreshCw,
    Search,
    Rows,
    Columns,
    FileDiff,
    Plus,
    Minus
  } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import type { DiffHunk } from '@shared/types/git.js';
  import { sessions } from '../../stores/sessions.svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import ChangeRow from './ChangeRow.svelte';
  import HunkBlock from './HunkBlock.svelte';

  type FilterValue = 'all' | 'staged' | 'unstaged' | 'untracked';

  const filterOptions: ReadonlyArray<{ id: FilterValue; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'staged', label: 'Staged' },
    { id: 'unstaged', label: 'Unstaged' },
    { id: 'untracked', label: 'New' }
  ];

  let selected = $derived(sessions.selected);

  // The worktree cwd anchors every store key. We register run-mode + WSL distro
  // so the IPC layer can dispatch to native or WSL git as appropriate.
  let activeCwd = $derived.by<string | null>(() => {
    const cwd = selected?.cwd?.trim();
    return cwd && cwd.length > 0 ? cwd : null;
  });

  $effect(() => {
    if (!activeCwd || !selected) return;
    workingDiff.setContext(activeCwd, {
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    });
  });

  // Auto-load changes whenever the active worktree changes. Subsequent refreshes
  // are pushed by the git change listener attached on mount.
  $effect(() => {
    const cwd = activeCwd;
    if (!cwd) return;
    void workingDiff
      .loadChanges(cwd)
      .then((result) => {
        // Kick off the eager prefetch as soon as the file list lands. Each
        // diff request is deduped against the in-flight selection click so
        // there's no race penalty for the file the user picks first.
        if (result) void workingDiff.prefetchDiffs(cwd);
      })
      .catch(reportError);
  });

  // Whenever the user changes the context-lines slider, every diff entry is
  // wiped. Re-prime the cache so subsequent clicks stay instant — the active
  // file is already being refetched by the selection effect below.
  $effect(() => {
    const cwd = activeCwd;
    workingDiff.contextLines;
    if (!cwd) return;
    if (!workingDiff.changesFor(cwd).result) return;
    void workingDiff.prefetchDiffs(cwd);
  });

  let changesEntry = $derived(activeCwd ? workingDiff.changesFor(activeCwd) : null);
  let filteredChanges = $derived(activeCwd ? workingDiff.filteredChangesFor(activeCwd) : []);
  let totalChangeCount = $derived(changesEntry?.result?.changes.length ?? 0);

  // The selection in the store is the source of truth, but we want to fall
  // back to the first visible change so the diff pane is never empty when
  // there's something to show.
  let storedSelected = $derived(activeCwd ? workingDiff.selectedFilePath(activeCwd) : null);
  let effectiveSelected = $derived.by<string | null>(() => {
    if (!filteredChanges.length) return null;
    if (storedSelected && filteredChanges.some((c) => c.path === storedSelected)) {
      return storedSelected;
    }
    return filteredChanges[0]?.path ?? null;
  });

  $effect(() => {
    if (!activeCwd) return;
    const next = effectiveSelected;
    if (next && next !== storedSelected) {
      workingDiff.setSelected(activeCwd, next);
    }
  });

  $effect(() => {
    const cwd = activeCwd;
    const path = effectiveSelected;
    if (!cwd || !path) {
      if (cwd) workingDiff.setActive({ cwd, filePath: '' });
      return;
    }
    workingDiff.setActive({ cwd, filePath: path });
    void workingDiff.loadDiff(cwd, path).catch(reportError);
  });

  let diffEntry = $derived(
    activeCwd && effectiveSelected ? workingDiff.diffEntryFor(activeCwd, effectiveSelected) : null
  );

  // Gutter width hint: scale with the largest line number we will render.
  let gutterWidth = $derived.by<number>(() => {
    const hunks: DiffHunk[] = diffEntry?.diff?.hunks ?? [];
    let max = 0;
    for (const hunk of hunks) {
      const oldEnd = hunk.oldStart + hunk.oldCount;
      const newEnd = hunk.newStart + hunk.newCount;
      if (oldEnd > max) max = oldEnd;
      if (newEnd > max) max = newEnd;
    }
    return Math.max(2, String(max).length);
  });

  let queryDraft = $state(workingDiff.query);

  function commitQuery(): void {
    workingDiff.query = queryDraft;
  }

  let stagedChanges = $derived(filteredChanges.filter((c) => c.staged));
  let unstagedChanges = $derived(filteredChanges.filter((c) => !c.staged));
  let showGroups = $derived(workingDiff.filter === 'all' && (stagedChanges.length > 0 || unstagedChanges.length > 0));

  function pickChange(path: string): void {
    if (!activeCwd) return;
    workingDiff.setSelected(activeCwd, path);
  }

  async function stageFile(path: string): Promise<void> {
    if (!activeCwd) return;
    await workingDiff.stageFiles(activeCwd, [path]);
  }

  async function unstageFile(path: string): Promise<void> {
    if (!activeCwd) return;
    await workingDiff.unstageFiles(activeCwd, [path]);
  }

  async function stageAll(): Promise<void> {
    if (!activeCwd) return;
    const paths = unstagedChanges.map((c) => c.path);
    if (paths.length) await workingDiff.stageFiles(activeCwd, paths);
  }

  async function unstageAll(): Promise<void> {
    if (!activeCwd) return;
    const paths = stagedChanges.map((c) => c.path);
    if (paths.length) await workingDiff.unstageFiles(activeCwd, paths);
  }

  async function refresh(): Promise<void> {
    if (!activeCwd) return;
    workingDiff.invalidate(activeCwd);
    try {
      const result = await workingDiff.loadChanges(activeCwd);
      if (result) void workingDiff.prefetchDiffs(activeCwd);
    } catch (err) {
      reportError(err);
    }
  }

  function clampContext(value: number): number {
    return Math.max(0, Math.min(50, Math.trunc(value)));
  }

  function setContextLines(value: number): void {
    // The store clears every diff body and bumps generations; the prefetch
    // effect below re-primes the cache against the new context-lines value
    // (active file first), so we don't need to issue a manual fetch here.
    workingDiff.setContextLines(clampContext(value));
  }

  onMount(() => {
    workingDiff.attachListeners();
    return () => workingDiff.detach();
  });
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
    <div class="flex min-w-0 flex-col">
      <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        Working tree
      </span>
      <span class="truncate text-xs text-foreground">
        {selected ? selected.name : 'No session selected'}
      </span>
    </div>
    <div class="flex items-center gap-1">
      <Button
        variant="ghost"
        size="xs"
        onclick={() =>
          (workingDiff.viewMode = workingDiff.viewMode === 'unified' ? 'split' : 'unified')}
        aria-label={workingDiff.viewMode === 'unified' ? 'Switch to split view' : 'Switch to unified view'}
        title={workingDiff.viewMode === 'unified' ? 'Split view' : 'Unified view'}
        disabled={!activeCwd}
      >
        {#if workingDiff.viewMode === 'unified'}
          <Columns class="size-3" />
        {:else}
          <Rows class="size-3" />
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onclick={() => void refresh()}
        aria-label="Refresh changes"
        title="Refresh"
        disabled={!activeCwd || changesEntry?.loading}
      >
        {#if changesEntry?.loading}
          <Loader2 class="size-3 animate-spin" />
        {:else}
          <RefreshCw class="size-3" />
        {/if}
      </Button>
    </div>
  </header>

  {#if !activeCwd}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      Pick a session to inspect its working tree.
    </div>
  {:else if changesEntry?.result && !changesEntry.result.isRepo}
    <div class="flex flex-1 items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
      <GitCompare class="size-4 shrink-0" />
      <span>This folder isn't a git repository.</span>
    </div>
  {:else}
    <div class="flex flex-col gap-1.5 border-b border-border px-3 py-2">
      <div class="relative">
        <Search class="absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          bind:value={queryDraft}
          oninput={commitQuery}
          placeholder="Filter by path"
          aria-label="Filter changes"
          class="h-7 pl-6 text-xs"
        />
      </div>
      <div class="flex items-center justify-between gap-1.5 text-[10px]">
        <div class="flex items-center gap-0.5">
          {#each filterOptions as opt (opt.id)}
            {@const active = workingDiff.filter === opt.id}
            <button
              type="button"
              class={[
                'rounded-md px-1.5 py-0.5 transition-colors',
                active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              ]}
              onclick={() => (workingDiff.filter = opt.id)}
              aria-pressed={active}
            >
              {opt.label}
            </button>
          {/each}
        </div>
        <label class="flex items-center gap-1 text-muted-foreground">
          <span>ctx</span>
          <input
            type="number"
            min="0"
            max="50"
            value={workingDiff.contextLines}
            oninput={(e) =>
              setContextLines(Number((e.currentTarget as HTMLInputElement).value))}
            class="h-5 w-9 rounded border border-input bg-transparent px-1 text-right font-mono text-[10px] outline-none focus:border-ring"
            aria-label="Context lines"
          />
        </label>
      </div>
    </div>

    <ScrollArea class="max-h-56 shrink-0 border-b border-border">
      <div class="flex flex-col gap-px p-1.5">
        {#if changesEntry?.loading && filteredChanges.length === 0}
          <div class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 class="size-3 animate-spin" />
            Loading…
          </div>
        {:else if changesEntry?.error}
          <div class="flex items-start gap-2 px-2 py-3 text-xs text-destructive">
            <AlertCircle class="size-3 shrink-0" />
            <span class="break-words">{changesEntry.error}</span>
          </div>
        {:else if filteredChanges.length === 0}
          <div class="px-2 py-3 text-xs text-muted-foreground">
            {#if totalChangeCount === 0}
              Working tree is clean.
            {:else}
              Nothing matches the current filter.
            {/if}
          </div>
        {:else if showGroups}
          {#if stagedChanges.length > 0}
            <div class="flex items-center justify-between px-2 pt-1.5 pb-0.5">
              <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Staged ({stagedChanges.length})
              </span>
              <button
                type="button"
                class="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
                onclick={() => void unstageAll().catch(reportError)}
                title="Unstage all"
                aria-label="Unstage all"
              >
                <Minus class="size-3" />
              </button>
            </div>
            {#each stagedChanges as change (change.path)}
              <ChangeRow
                {change}
                selected={change.path === effectiveSelected}
                onpick={() => pickChange(change.path)}
                onunstage={() => void unstageFile(change.path).catch(reportError)}
              />
            {/each}
          {/if}
          {#if unstagedChanges.length > 0}
            <div class="flex items-center justify-between px-2 pt-1.5 pb-0.5">
              <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                Changes ({unstagedChanges.length})
              </span>
              <button
                type="button"
                class="flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
                onclick={() => void stageAll().catch(reportError)}
                title="Stage all"
                aria-label="Stage all"
              >
                <Plus class="size-3" />
              </button>
            </div>
            {#each unstagedChanges as change (change.path)}
              <ChangeRow
                {change}
                selected={change.path === effectiveSelected}
                onpick={() => pickChange(change.path)}
                onstage={() => void stageFile(change.path).catch(reportError)}
              />
            {/each}
          {/if}
        {:else}
          {#each filteredChanges as change (change.path)}
            <ChangeRow
              {change}
              selected={change.path === effectiveSelected}
              onpick={() => pickChange(change.path)}
              onstage={!change.staged ? () => void stageFile(change.path).catch(reportError) : undefined}
              onunstage={change.staged ? () => void unstageFile(change.path).catch(reportError) : undefined}
            />
          {/each}
        {/if}
      </div>
    </ScrollArea>

    <section class="flex min-h-0 flex-1 flex-col">
      {#if !effectiveSelected}
        <div class="flex flex-1 items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
          <FileDiff class="size-4 shrink-0" />
          <span>Pick a file above to inspect its diff.</span>
        </div>
      {:else if diffEntry?.loading && !diffEntry.diff}
        <div class="flex flex-1 items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
          <Loader2 class="size-3 animate-spin" />
          Loading diff…
        </div>
      {:else if diffEntry?.error}
        <div class="flex flex-1 items-start justify-center gap-2 px-3 py-4 text-xs text-destructive">
          <AlertCircle class="size-3 shrink-0" />
          <span class="break-words">{diffEntry.error}</span>
        </div>
      {:else if diffEntry?.diff}
        {@const diff = diffEntry.diff}
        <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <div class="flex min-w-0 flex-col">
            <span class="truncate font-mono text-[11px] text-foreground">{diff.path}</span>
            {#if diff.fromPath && diff.fromPath !== diff.path}
              <span class="truncate text-[10px] text-muted-foreground">from {diff.fromPath}</span>
            {/if}
          </div>
          <span class="shrink-0 font-mono text-[10px] text-muted-foreground uppercase">
            {diff.kind}
          </span>
        </header>
        {#if diff.binary}
          <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
            Binary file — diff not shown.
          </div>
        {:else if diff.empty || diff.hunks.length === 0}
          <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
            No textual changes.
          </div>
        {:else}
          <ScrollArea class="min-h-0 flex-1">
            <div class="flex flex-col">
              {#each diff.hunks as hunk, idx (idx)}
                <HunkBlock {hunk} mode={workingDiff.viewMode} {gutterWidth} />
              {/each}
            </div>
          </ScrollArea>
        {/if}
      {:else}
        <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
          Select a file to view changes.
        </div>
      {/if}
    </section>
  {/if}
</div>
