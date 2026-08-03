<script lang="ts">
  import {
    AlertCircle,
    Check,
    GitBranch,
    GitCommitHorizontal,
    History,
    Loader2,
    Search,
    Tag,
    ChevronsUpDown,
    X
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type {
    GitBranch as GitBranchInfo,
    GitHistoryCommit,
    GitHistoryRef,
    GitStatus,
    GitWorktree
  } from '@shared/types/git.js';
  import { worktreeRuntimeContext } from '@shared/worktree-identity.js';
  import {
    branchHistoryHashes,
    buildGitHistoryGraph,
    commitRangeHashes,
    filterGitHistory,
    reviewRangeRefs,
    scopeGitHistory
  } from '../../lib/git-history-graph';
  import { resolveBranchReviewScope } from '../../lib/branch-review-scope';
  import { ipc } from '../../lib/ipc';
  import {
    workingDiff,
    type ReviewMode,
    type ReviewScope
  } from '../../stores/working-diff.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Command from '$lib/components/ui/command';
  import * as Popover from '$lib/components/ui/popover';

  const HISTORY_LIMIT = 500;
  const LANE_WIDTH = 12;
  const LANE_COLORS = [
    'var(--primary)',
    '#22c55e',
    '#f59e0b',
    '#a855f7',
    '#06b6d4',
    '#f43f5e'
  ];

  let {
    scope,
    onClose,
    onApplyScope = () => undefined
  }: {
    scope: ReviewScope;
    onClose: () => void;
    onApplyScope?: (scope: ReviewScope) => void;
  } = $props();
  let cwd = $derived(scope.cwd);

  let history = $state<GitHistoryCommit[]>([]);
  let branches = $state<GitBranchInfo[]>([]);
  let worktrees = $state<GitWorktree[]>([]);
  let loadedStatus = $state<GitStatus | null>(null);
  let selectedWorktreeStatus = $state<GitStatus | null>(null);
  let selectedWorktreeStatusChecked = $state(false);
  let branchMenuOpen = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let query = $state('');
  let selectedBranch = $state<string | null>(null);
  let historyGeneration = 0;
  let worktreeStatusGeneration = 0;

  let mode = $derived(workingDiff.reviewModeFor(scope));

  // Snapshot the mode at mount so the picker's initial selection matches
  // whatever range is already active without becoming reactive to subsequent
  // store changes — the user is editing a draft inside the popover.
  const initialMode = untrack(() => workingDiff.reviewModeFor(scope));
  if (initialMode.kind === 'range') selectedBranch = initialMode.branchContext ?? null;
  let selectionAnchor = $state<string | null>(
    initialMode.kind === 'range' ? initialMode.commits[0]?.hash ?? null : null
  );
  let selectionFocus = $state<string | null>(
    initialMode.kind === 'range' ? initialMode.commits.at(-1)?.hash ?? null : null
  );
  let includeWt = $state<boolean>(
    initialMode.kind === 'range' ? initialMode.includeWorkingTree : false
  );
  let comparisonBase = $state<string>(
    initialMode.kind === 'range' ? initialMode.comparisonBaseRef ?? '' : ''
  );
  let applying = $state(false);
  let resolveError = $state<string | null>(null);

  // The terminal branch switcher and this picker read the same decorated
  // history. Keeping refs and parents here lets the picker use the same graph
  // and makes branch refs directly selectable without checking anything out.
  async function loadHistory(): Promise<void> {
    const generation = ++historyGeneration;
    loading = true;
    error = null;
    try {
      const ctx = worktreeRuntimeContext(scope);
      const status = await ipc.git.status({ cwd, force: true, ...ctx });
      if (generation !== historyGeneration) return;
      loadedStatus = status;
      const repoPath = status.repoPath;
      if (!repoPath) {
        history = [];
        branches = [];
        worktrees = [];
        return;
      }
      const [nextHistory, nextBranches, nextWorktrees] = await Promise.all([
        ipc.git.refHistory({
          repoPath,
          limit: HISTORY_LIMIT,
          force: true,
          ...ctx
        }),
        ipc.git.branches({ repoPath, force: true, ...ctx }),
        ipc.git.worktrees({ repoPath, force: true, ...ctx })
      ]);
      if (generation !== historyGeneration) return;
      history = nextHistory;
      branches = nextBranches;
      worktrees = nextWorktrees;
      if (selectedBranch === null && initialMode.kind === 'working-tree') {
        selectedBranch = status.branch;
      }
    } catch (err) {
      if (generation !== historyGeneration) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (generation === historyGeneration) loading = false;
    }
  }

  $effect(() => {
    void loadHistory();
  });

  let selectedBranchResolution = $derived(
    selectedBranch
      ? resolveBranchReviewScope(scope, selectedBranch, worktrees)
      : { scope, worktree: null }
  );

  async function loadSelectedWorktreeStatus(): Promise<void> {
    const branch = selectedBranch;
    const resolution = selectedBranchResolution;
    const generation = ++worktreeStatusGeneration;
    selectedWorktreeStatus = null;
    selectedWorktreeStatusChecked = false;
    if (!branch || !resolution.worktree) return;
    if (resolution.scope.cwd === scope.cwd && loadedStatus?.branch === branch) {
      selectedWorktreeStatus = loadedStatus;
      selectedWorktreeStatusChecked = true;
      return;
    }
    try {
      const status = await ipc.git.status({
        cwd: resolution.scope.cwd,
        force: true,
        ...worktreeRuntimeContext(resolution.scope)
      });
      if (generation === worktreeStatusGeneration && selectedBranch === branch) {
        selectedWorktreeStatus = status;
        selectedWorktreeStatusChecked = true;
      }
    } catch {
      if (generation === worktreeStatusGeneration) {
        selectedWorktreeStatus = null;
        selectedWorktreeStatusChecked = true;
      }
    }
  }

  $effect(() => {
    void selectedBranch;
    void worktrees;
    void loadedStatus;
    void loadSelectedWorktreeStatus();
  });

  let branchCommitHashes = $derived(
    selectedBranch ? branchHistoryHashes(history, selectedBranch) : null
  );
  let scopedHistory = $derived(
    selectedBranch
      ? scopeGitHistory(history, branchCommitHashes ?? new Set<string>())
      : history
  );
  let selected = $derived(commitRangeHashes(scopedHistory, selectionAnchor, selectionFocus));
  let filteredHistory = $derived(filterGitHistory(scopedHistory, query, 'all'));
  let graphRows = $derived(buildGitHistoryGraph(filteredHistory));
  let maxLanes = $derived(
    Math.max(1, ...graphRows.map((row) => Math.max(row.laneCount, row.nextLaneCount)))
  );
  let graphWidth = $derived(maxLanes * LANE_WIDTH + 8);
  let uncommittedCount = $derived(
    (selectedWorktreeStatus?.staged ?? 0) +
    (selectedWorktreeStatus?.unstaged ?? 0) +
    (selectedWorktreeStatus?.untracked ?? 0)
  );
  let selectedBranchHasWorktree = $derived(selectedBranchResolution.worktree !== null);
  let selectedWorktreeAvailable = $derived(
    selectedBranchHasWorktree &&
      selectedWorktreeStatus?.isRepo === true &&
      selectedWorktreeStatus.branch === selectedBranch
  );
  let selectionDetails = $derived(reviewRangeRefs(history, selected, comparisonBase));

  function toggle(hash: string, checked: boolean): void {
    if (!checked) {
      clearSelection();
      return;
    }
    if (!selectionAnchor || !selectionFocus || selectionAnchor !== selectionFocus) {
      selectionAnchor = hash;
      selectionFocus = hash;
      return;
    }
    selectionFocus = hash;
  }

  function selectAll(): void {
    const visible = new Set(filteredHistory.map((commit) => commit.hash));
    const indexes = scopedHistory
      .map((commit, index) => visible.has(commit.hash) ? index : -1)
      .filter((index) => index >= 0);
    if (indexes.length === 0) {
      clearSelection();
      return;
    }
    const newest = scopedHistory[Math.min(...indexes)];
    const oldest = scopedHistory[Math.max(...indexes)];
    selectionAnchor = oldest?.hash ?? null;
    selectionFocus = newest?.hash ?? null;
  }

  function clearSelection(): void {
    selectionAnchor = null;
    selectionFocus = null;
  }

  function chooseBranch(ref: string): void {
    const branch = ref === '__all__' ? null : ref;
    selectedBranch = branch;
    includeWt = branch !== null && resolveBranchReviewScope(scope, branch, worktrees).worktree !== null;
    branchMenuOpen = false;
    clearSelection();
  }

  function updateComparisonBase(event: Event): void {
    comparisonBase = (event.currentTarget as HTMLInputElement).value;
  }

  function clearComparisonBase(): void {
    comparisonBase = '';
  }

  async function apply(): Promise<void> {
    if (applying) return;
    if (selected.size === 0 && !selectedBranch) {
      resolveError = 'Choose a branch or select commits to review.';
      return;
    }
    applying = true;
    resolveError = null;
    try {
      const resolution = selectedBranch
        ? resolveBranchReviewScope(scope, selectedBranch, worktrees)
        : { scope, worktree: null };
      const reviewScope = resolution.scope;
      let canIncludeWorkingTree = false;
      if (selectedBranch && resolution.worktree) {
        const status = await ipc.git.status({
          cwd: reviewScope.cwd,
          force: true,
          ...worktreeRuntimeContext(reviewScope)
        });
        if (!status.isRepo || status.branch !== selectedBranch) {
          throw new Error(
            `The Worktree for ${selectedBranch} is unavailable at ${resolution.worktree.path}.`
          );
        }
        canIncludeWorkingTree = true;
      }
      const reviewCwd = reviewScope.cwd;
      const ctx = worktreeRuntimeContext(reviewScope);
      if (selected.size === 0 && selectedBranch) {
        const resolved = await ipc.git.resolveRefs({
          cwd: reviewCwd,
          refs: [selectedBranch],
          ...ctx
        });
        const tip = resolved.resolved[0] ?? null;
        if (!tip) throw new Error(`Couldn't resolve branch ${selectedBranch}.`);
        workingDiff.setReviewMode(reviewScope, {
          kind: 'range',
          base: tip,
          head: tip,
          commits: [],
          includeWorkingTree: canIncludeWorkingTree,
          chipFilter: null,
          branchContext: selectedBranch
        });
        onApplyScope(reviewScope);
        onClose();
        return;
      }

      const draft = reviewRangeRefs(history, selected, comparisonBase);
      if (!draft) throw new Error('The selected commits are no longer in the loaded history.');
      const resolved = await ipc.git.resolveRefs({
        cwd: reviewCwd,
        refs: [draft.base, draft.head],
        ...ctx
      });
      const resolvedBase = resolved.resolved[0] ?? null;
      const resolvedHead = resolved.resolved[1] ?? null;

      if (!resolvedBase || !resolvedHead) {
        resolveError = !resolvedBase && !comparisonBase.trim()
          ? 'The oldest selected commit has no parent. Enter a comparison base to review it.'
          : `Couldn't resolve ${!resolvedBase ? 'the comparison base' : 'the newest selected commit'}.`;
        applying = false;
        return;
      }

      // Topo-order the resolved range so committed file attribution uses Git's
      // ordering, not the filtered history order. A manual base may widen the
      // final range beyond the visual endpoints selected in the picker.
      const { commits: ordered, truncated } = await ipc.git.commitsBetween({
        cwd: reviewCwd,
        base: resolvedBase,
        head: resolvedHead,
        ...ctx
      });
      if (truncated) {
        reportError('Range hit the 500-commit cap; only the first 500 will be tracked.');
      }
      const next: ReviewMode = {
        kind: 'range',
        base: resolvedBase,
        head: resolvedHead,
        commits: ordered,
        includeWorkingTree: includeWt && canIncludeWorkingTree,
        chipFilter: null,
        comparisonBaseRef: comparisonBase.trim() || undefined,
        branchContext: selectedBranch ?? undefined
      };
      workingDiff.setReviewMode(reviewScope, next);
      onApplyScope(reviewScope);
      onClose();
    } catch (err) {
      reportError(err);
      resolveError = err instanceof Error ? err.message : String(err);
    } finally {
      applying = false;
    }
  }

  function reset(): void {
    workingDiff.clearReviewMode(scope);
    clearSelection();
    selectedBranch = null;
    comparisonBase = '';
    resolveError = null;
    onClose();
  }

  function refIcon(ref: GitHistoryRef) {
    return ref.kind === 'tag' ? Tag : GitBranch;
  }

  function laneColor(lane: number): string {
    return LANE_COLORS[lane % LANE_COLORS.length]!;
  }

  function graphX(lane: number): number {
    return 4 + lane * LANE_WIDTH;
  }

  function edgePath(from: number, to: number): string {
    const fromX = graphX(from);
    const toX = graphX(to);
    return `M ${fromX} 0 C ${fromX} 12, ${toX} 32, ${toX} 44`;
  }

  function formattedDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }
</script>

<div class="flex h-[min(34rem,calc(100vh-3rem))] w-[min(46rem,calc(100vw-2rem))] max-w-[90vw] min-h-0 flex-col overflow-hidden p-3">
  <div class="flex shrink-0 items-center justify-between gap-2">
    <div class="flex min-w-0 items-center gap-1.5">
      <GitCommitHorizontal class="size-3.5 text-muted-foreground" />
      <span class="truncate text-xs font-medium text-foreground">Choose commits to review</span>
    </div>
    <Button
      variant="ghost"
      size="xs"
      onclick={onClose}
      aria-label="Close commit picker"
      title="Close"
    >
      <X />
    </Button>
  </div>

  <p class="m-0 mt-1 shrink-0 text-[10px] leading-4 text-muted-foreground">
    Choose a branch to inspect its history and checked-out Worktree, wherever that folder lives.
    Commit selection is optional and only defines a range.
  </p>

  <div class="mt-2 grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2">
    <div class="flex min-w-0 flex-col gap-1">
      <Label for="commit-picker-branch" class="text-[10px] text-muted-foreground">
        Browse branch history
      </Label>
      <Popover.Root bind:open={branchMenuOpen}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              id="commit-picker-branch"
              variant="outline"
              size="sm"
              class="w-full justify-between"
              disabled={loading || applying}
              aria-expanded={branchMenuOpen}
            >
              <span class="truncate">{selectedBranch ?? 'All branches'}</span>
              <ChevronsUpDown data-icon="inline-end" />
            </Button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content align="start" class="w-[22rem] max-w-[calc(100vw-3rem)] p-0">
          <Command.Root>
            <Command.Input placeholder="Find a branch or Worktree path…" />
            <Command.List class="max-h-64">
              <Command.Empty>No matching branch.</Command.Empty>
              <Command.Group heading="Branches">
                <Command.Item
                  value="__all__ All branches"
                  data-checked={selectedBranch === null}
                  onSelect={() => chooseBranch('__all__')}
                >
                  <GitBranch />
                  <span>All branches</span>
                </Command.Item>
                {#each branches as branch (branch.name)}
                  {@const branchWorktree = worktrees.find(
                    (worktree) => !worktree.bare && !worktree.detached && worktree.branch === branch.name
                  )}
                  <Command.Item
                    value={`${branch.name} ${branchWorktree?.path ?? ''}`}
                    data-checked={selectedBranch === branch.name}
                    onSelect={() => chooseBranch(branch.name)}
                  >
                    <GitBranch />
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate">{branch.name}</span>
                      <span class="truncate text-[10px] text-muted-foreground">
                        {branchWorktree?.path ?? 'Not checked out in a Worktree'}
                      </span>
                    </span>
                  </Command.Item>
                {/each}
              </Command.Group>
            </Command.List>
          </Command.Root>
        </Popover.Content>
      </Popover.Root>
      <p class="m-0 text-[10px] leading-4 text-muted-foreground">
        {#if selectedWorktreeAvailable}
          Checked out at <span class="break-all font-mono text-foreground">{selectedBranchResolution.worktree?.path}</span>.
          Its {uncommittedCount} uncommitted {uncommittedCount === 1 ? 'change' : 'changes'} will be shown.
        {:else if selectedBranchHasWorktree && !selectedWorktreeStatusChecked}
          Checking <span class="break-all font-mono text-foreground">{selectedBranchResolution.worktree?.path}</span>…
        {:else if selectedBranchHasWorktree}
          The registered Worktree is unavailable at
          <span class="break-all font-mono text-foreground">{selectedBranchResolution.worktree?.path}</span>.
        {:else if selectedBranch}
          This branch is not checked out, so it has no Worktree changes to show.
        {:else}
          Showing the loaded graph across every local branch.
        {/if}
      </p>
    </div>

    <div class="flex min-w-0 flex-col gap-1">
      <Label for="commit-picker-comparison-base" class="text-[10px] text-muted-foreground">
        Comparison base <span class="font-normal">(optional override)</span>
      </Label>
      <div class="flex items-center gap-1">
        <Input
          id="commit-picker-comparison-base"
          value={comparisonBase}
          oninput={updateComparisonBase}
          placeholder="main, HEAD~5, or a SHA"
          class="h-7 min-w-0 flex-1 text-xs"
        />
        {#if comparisonBase}
          <Button
            variant="ghost"
            size="xs"
            onclick={clearComparisonBase}
            aria-label="Use automatic comparison base"
            title="Use automatic comparison base"
          >
            <X />
          </Button>
        {/if}
      </div>
      <p class="m-0 text-[10px] leading-4 text-muted-foreground">
        {#if comparisonBase.trim()}
          Manual base: <span class="font-mono text-foreground">{comparisonBase.trim()}</span>.
        {:else}
          Automatic: the parent immediately before the oldest selected commit.
        {/if}
      </p>
    </div>
  </div>

  {#if selectionDetails}
    <div
      class="mt-2 flex shrink-0 items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-[10px]"
      aria-live="polite"
    >
      <span class="text-muted-foreground">Review</span>
      <span class="font-mono text-foreground">
        {comparisonBase.trim() || `${selectionDetails.oldest.shortHash}^`}
      </span>
      <span class="text-muted-foreground">→</span>
      <span class="font-mono text-foreground">{selectionDetails.newest.shortHash}</span>
      <span class="text-muted-foreground">
        · {selected.size} commit{selected.size === 1 ? '' : 's'}
        {#if selectedBranch} on {selectedBranch}{/if}
      </span>
    </div>
  {/if}

  <div class="mt-3 flex shrink-0 flex-col gap-1.5">
    <div class="relative">
      <Search class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        bind:value={query}
        class="h-7 pl-7 text-[11px]"
        placeholder="Search branches, commits, authors, or hashes…"
        aria-label="Search branches and commits"
      />
    </div>
    <div class="flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
      <span>Select commits only to review their changes; otherwise the branch view shows Worktree changes.</span>
      <div class="flex items-center gap-1">
        <span>{selected.size} selected</span>
        <Button variant="ghost" size="xs" onclick={selectAll} disabled={filteredHistory.length === 0}>
          Select all
        </Button>
        <Button variant="ghost" size="xs" onclick={clearSelection} disabled={selected.size === 0}>
          Clear
        </Button>
      </div>
    </div>
  </div>

  <ScrollArea class="mt-1.5 min-h-0 flex-1 rounded border border-border">
    {#if loading && history.length === 0}
      <div class="flex items-center gap-2 px-4 py-8 text-xs text-muted-foreground">
        <Loader2 class="size-3 animate-spin" />
        Loading branches and commits…
      </div>
    {:else if error && history.length === 0}
      <div class="flex items-start gap-2 px-4 py-8 text-xs text-destructive">
        <AlertCircle class="mt-0.5 size-3 shrink-0" />
        <div class="min-w-0">
          <div class="break-words">{error}</div>
          <button
            type="button"
            class="mt-2 cursor-pointer underline underline-offset-2"
            onclick={() => void loadHistory()}
          >
            Retry
          </button>
        </div>
      </div>
    {:else if graphRows.length === 0}
      <div class="flex items-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
        <History class="mx-auto size-3" />
        <span>
          {#if selectedBranch && branchCommitHashes === null}
            The tip of {selectedBranch} is outside the loaded {HISTORY_LIMIT}-commit history.
          {:else}
            No matching branches or commits.
          {/if}
        </span>
      </div>
    {:else}
      <div class="py-1">
        {#each graphRows as row (row.commit.hash)}
          {@const isSelected = selected.has(row.commit.hash)}
          <div
            class={[
              'group flex min-h-11 items-stretch border-b border-border/40 last:border-b-0',
              isSelected ? 'bg-muted/70' : 'hover:bg-muted/40'
            ]}
          >
            <svg
              class="shrink-0 overflow-visible"
              style={`width: ${graphWidth}px;`}
              viewBox={`0 0 ${graphWidth} 44`}
              aria-hidden="true"
            >
              {#each row.edges as edge, edgeIndex (`${edge.from}:${edge.to}:${edgeIndex}`)}
                <path
                  d={edgePath(edge.from, edge.to)}
                  fill="none"
                  stroke={laneColor(edge.from)}
                  stroke-width="1.5"
                />
              {/each}
              <circle
                cx={graphX(row.nodeLane)}
                cy="22"
                r="3.5"
                fill="var(--background)"
                stroke={laneColor(row.nodeLane)}
                stroke-width="2"
              />
            </svg>

            <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-2 text-left">
              <Checkbox
                checked={isSelected}
                onCheckedChange={(checked) => toggle(row.commit.hash, checked === true)}
                aria-label={`Select commit ${row.commit.shortHash}`}
              />
              <span class="w-13 shrink-0 font-mono text-[10px] text-muted-foreground">
                {row.commit.shortHash}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[11px] text-foreground">
                  {row.commit.subject}
                </span>
                <span class="block truncate text-[10px] text-muted-foreground">
                  {row.commit.author} · {formattedDate(row.commit.authoredAt)}
                </span>
              </span>
            </label>

            {#if row.commit.refs.length > 0}
              <div class="flex max-w-[42%] flex-wrap items-center justify-end gap-1 py-1.5 pr-2">
                {#each row.commit.refs as ref (`${ref.kind}:${ref.name}`)}
                  {@const RefIcon = refIcon(ref)}
                  {#if ref.kind === 'branch'}
                    <button
                      type="button"
                      class={`inline-flex h-5 min-w-0 cursor-pointer items-center gap-1 rounded border px-1.5 text-[9px] transition-colors ${
                        selectedBranch === ref.name
                          ? 'border-primary/50 bg-primary/10 text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground'
                      }`}
                      title={`Browse commits reachable from ${ref.name}`}
                      disabled={applying}
                      onclick={() => chooseBranch(ref.name)}
                    >
                      {#if selectedBranch === ref.name}
                        <Check class="size-2.5 shrink-0" />
                      {:else}
                        <RefIcon class="size-2.5 shrink-0" />
                      {/if}
                      <span class="max-w-32 truncate">{ref.name}</span>
                    </button>
                  {:else}
                    <span
                      class="inline-flex h-5 min-w-0 items-center gap-1 rounded border border-border px-1.5 text-[9px] text-muted-foreground"
                      title={`${ref.kind} ${ref.name}`}
                    >
                      <RefIcon class="size-2.5 shrink-0" />
                      <span class="max-w-32 truncate">{ref.name}</span>
                    </span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </ScrollArea>

  {#if selected.size === 0}
    <div class="mt-2 shrink-0 text-[10px] leading-4 text-muted-foreground">
      {#if selectedWorktreeAvailable}
        Branch view shows the Worktree at
        <span class="break-all font-mono text-foreground">{selectedBranchResolution.worktree?.path}</span>
        with {uncommittedCount} uncommitted
        {uncommittedCount === 1 ? 'change' : 'changes'}. If it is clean, the viewer is empty.
      {:else if selectedBranchHasWorktree && !selectedWorktreeStatusChecked}
        Checking the selected branch's Worktree…
      {:else if selectedBranchHasWorktree}
        This branch's registered Worktree folder is unavailable. Its uncommitted changes cannot be read.
      {:else if selectedBranch}
        This branch is not checked out in any Worktree, so branch view has no uncommitted changes.
        Select commits above to review its committed changes.
      {:else}
        Choose a branch to view its history or select commits from the full graph.
      {/if}
    </div>
  {:else}
    <div class="mt-2 flex shrink-0 items-start gap-2">
      <Checkbox
        id="commit-picker-include-worktree"
        bind:checked={includeWt}
        disabled={!selectedWorktreeAvailable}
      />
      <div class="min-w-0">
        <Label for="commit-picker-include-worktree" class="text-xs text-foreground">
          Also show uncommitted changes
        </Label>
        <p class="m-0 text-[10px] leading-4 text-muted-foreground">
          {#if selectedWorktreeAvailable}
            Adds {uncommittedCount} staged, unstaged, or untracked
            {uncommittedCount === 1 ? 'change' : 'changes'} from
            <span class="break-all font-mono text-foreground">{selectedBranchResolution.worktree?.path}</span>
            in a separate section.
          {:else}
            Select a branch that is checked out in an available Worktree to include its changes.
          {/if}
        </p>
      </div>
    </div>
  {/if}

  {#if resolveError}
    <div
      class="mt-1.5 flex shrink-0 items-start gap-1 text-[10px] text-destructive"
      role="alert"
    >
      <AlertCircle class="size-3 shrink-0" />
      <span class="break-words">{resolveError}</span>
    </div>
  {/if}

  <div class="flex shrink-0 items-center justify-between gap-2 pt-2">
    <Button
      variant="ghost"
      size="xs"
      onclick={reset}
      disabled={mode.kind !== 'range'}
    >
      Show uncommitted only
    </Button>
    <Button
      size="xs"
      onclick={() => void apply()}
      disabled={
        applying ||
        (selected.size === 0 && !selectedBranch) ||
        (selected.size === 0 && selectedBranchHasWorktree && !selectedWorktreeAvailable)
      }
    >
      {#if applying}
        <Loader2 data-icon="inline-start" class="animate-spin" />
      {/if}
      {selected.size === 0 ? 'View branch' : 'Review selected commits'}
    </Button>
  </div>
</div>
