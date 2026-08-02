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
    X
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type {
    GitBranch as GitBranchInfo,
    GitHistoryCommit,
    GitHistoryRef
  } from '@shared/types/git.js';
  import { worktreeRuntimeContext } from '@shared/worktree-identity.js';
  import {
    buildGitHistoryGraph,
    filterGitHistory,
    scopeGitHistory,
    type GitHistoryFilter
  } from '../../lib/git-history-graph';
  import { ipc } from '../../lib/ipc';
  import { git } from '../../stores/git.svelte';
  import {
    workingDiff,
    type ReviewMode,
    type ReviewScope
  } from '../../stores/working-diff.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { ScrollArea } from '$lib/components/ui/scroll-area';

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
    onClose
  }: {
    scope: ReviewScope;
    onClose: () => void;
  } = $props();
  let cwd = $derived(scope.cwd);

  let history = $state<GitHistoryCommit[]>([]);
  let branches = $state<GitBranchInfo[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let query = $state('');
  let resultFilter = $state<GitHistoryFilter>('all');
  let selectedBranch = $state<string | null>(null);
  let branchCommitHashes = $state<Set<string> | null>(null);
  let branchLoading = $state(false);
  let branchError = $state<string | null>(null);
  let historyGeneration = 0;
  let branchGeneration = 0;

  let mode = $derived(workingDiff.reviewModeFor(scope));

  // Snapshot the mode at mount so the picker's initial selection matches
  // whatever range is already active without becoming reactive to subsequent
  // store changes — the user is editing a draft inside the popover.
  const initialMode = untrack(() => workingDiff.reviewModeFor(scope));
  const selected = new SvelteSet<string>(
    initialMode.kind === 'range' ? initialMode.commits.map((c) => c.hash) : []
  );
  let includeWt = $state<boolean>(
    initialMode.kind === 'range' ? initialMode.includeWorkingTree : true
  );
  let fromRef = $state<string>('');
  let applying = $state(false);
  let resolveError = $state<string | null>(null);

  // The terminal branch switcher and this picker read the same decorated
  // history. Keeping refs and parents here lets the picker use the same graph
  // and makes branch refs directly selectable without checking anything out.
  async function loadHistory(): Promise<void> {
    const status = git.statusFor(scope);
    const repoPath = status?.repoPath;
    if (!repoPath) {
      history = [];
      branches = [];
      loading = false;
      return;
    }
    const generation = ++historyGeneration;
    loading = true;
    error = null;
    const ctx = worktreeRuntimeContext(scope);
    Promise.all([
      ipc.git.refHistory({
        repoPath,
        limit: HISTORY_LIMIT,
        force: true,
        ...ctx
      }),
      ipc.git.branches({ repoPath, force: true, ...ctx })
    ])
      .then(([nextHistory, nextBranches]) => {
        if (generation !== historyGeneration) return;
        history = nextHistory;
        branches = nextBranches;
      })
      .catch((err: unknown) => {
        if (generation !== historyGeneration) return;
        error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        if (generation === historyGeneration) loading = false;
      });
  }

  $effect(() => {
    void loadHistory();
  });

  let scopedHistory = $derived(
    scopeGitHistory(history, selectedBranch && branchCommitHashes ? branchCommitHashes : null)
  );
  let filteredHistory = $derived(filterGitHistory(scopedHistory, query, resultFilter));
  let graphRows = $derived(buildGitHistoryGraph(filteredHistory));
  let maxLanes = $derived(
    Math.max(1, ...graphRows.map((row) => Math.max(row.laneCount, row.nextLaneCount)))
  );
  let graphWidth = $derived(maxLanes * LANE_WIDTH + 8);

  function toggle(hash: string): void {
    if (selected.has(hash)) selected.delete(hash);
    else selected.add(hash);
  }

  function selectAll(): void {
    for (const commit of filteredHistory) selected.add(commit.hash);
  }

  function clearSelection(): void {
    selected.clear();
  }

  async function chooseBranch(ref: string): Promise<void> {
    selectedBranch = ref;
    fromRef = ref;
    selected.clear();
    branchCommitHashes = null;
    branchError = null;
    resultFilter = 'all';

    const generation = ++branchGeneration;
    branchLoading = true;
    try {
      const ctx = worktreeRuntimeContext(scope);
      const resolved = await ipc.git.resolveRefs({ cwd, refs: [ref, 'HEAD'], ...ctx });
      if (generation !== branchGeneration) return;
      const [base, head] = resolved.resolved;
      if (!base || !head) throw new Error(`Couldn't resolve "${ref}".`);

      const range = await ipc.git.commitsBetween({ cwd, base, head, ...ctx });
      if (generation !== branchGeneration) return;
      branchCommitHashes = new Set(range.commits.map((commit) => commit.hash));
      if (range.truncated) {
        reportError('Branch range hit the 500-commit cap; only the first 500 are shown.');
      }
    } catch (err) {
      if (generation !== branchGeneration) return;
      branchError = err instanceof Error ? err.message : String(err);
    } finally {
      if (generation === branchGeneration) branchLoading = false;
    }
  }

  function updateFromRef(event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    fromRef = value;
    if (selectedBranch && value.trim() !== selectedBranch) {
      selectedBranch = null;
      branchCommitHashes = null;
      branchError = null;
      branchLoading = false;
      ++branchGeneration;
    }
  }

  function clearFromRef(): void {
    selectedBranch = null;
    fromRef = '';
    branchCommitHashes = null;
    branchError = null;
    branchLoading = false;
    ++branchGeneration;
  }

  async function apply(): Promise<void> {
    if (applying) return;
    if (selected.size === 0 && !fromRef.trim()) {
      resolveError = 'Pick at least one commit or choose a branch/ref.';
      return;
    }
    applying = true;
    resolveError = null;
    try {
      const ctx = worktreeRuntimeContext(scope);
      let resolvedBase: string | null = null;
      let resolvedHead: string | null = null;

      const orderedHashes = history
        .filter((commit) => selected.has(commit.hash))
        .map((commit) => commit.hash)
        .reverse();
      const useSelectedCommits = orderedHashes.length > 0 &&
        (selectedBranch !== null || !fromRef.trim());

      if (useSelectedCommits) {
        const earliest = orderedHashes[0];
        const newest = orderedHashes[orderedHashes.length - 1];
        if (!earliest || !newest) {
          resolveError = 'Selection lost.';
          applying = false;
          return;
        }
        const resolved = await ipc.git.resolveRefs({
          cwd,
          refs: [`${earliest}~1`, newest],
          ...ctx
        });
        resolvedBase = resolved.resolved[0] ?? null;
        resolvedHead = resolved.resolved[1] ?? null;
        if (!resolvedBase) {
          resolveError = "Couldn't resolve the parent of the earliest commit.";
          applying = false;
          return;
        }
      } else if (fromRef.trim()) {
        const resolved = await ipc.git.resolveRefs({ cwd, refs: [fromRef.trim(), 'HEAD'], ...ctx });
        const [base, head] = resolved.resolved;
        if (!base) {
          resolveError = `Couldn't resolve "${fromRef.trim()}".`;
          applying = false;
          return;
        }
        resolvedBase = base;
        resolvedHead = head ?? null;
      } else if (orderedHashes.length > 0) {
        const earliest = orderedHashes[0];
        const newest = orderedHashes[orderedHashes.length - 1];
        if (!earliest || !newest) {
          resolveError = 'Selection lost.';
          applying = false;
          return;
        }
        const resolved = await ipc.git.resolveRefs({
          cwd,
          refs: [`${earliest}~1`, newest],
          ...ctx
        });
        resolvedBase = resolved.resolved[0] ?? null;
        resolvedHead = resolved.resolved[1] ?? null;
      }

      if (!resolvedBase || !resolvedHead) {
        resolveError = 'Range incomplete.';
        applying = false;
        return;
      }

      // Topo-order the full range so committed file attribution uses git's
      // ordering, not the history search order. This also expands a selected
      // branch beyond the history rows currently visible in the picker.
      const { commits: ordered, truncated } = await ipc.git.commitsBetween({
        cwd,
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
        includeWorkingTree: includeWt,
        chipFilter: null
      };
      workingDiff.setReviewMode(scope, next);
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
    selected.clear();
    selectedBranch = null;
    branchCommitHashes = null;
    branchError = null;
    branchLoading = false;
    ++branchGeneration;
    fromRef = '';
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

<div class="flex h-[min(34rem,calc(100vh-4rem))] w-[min(46rem,calc(100vw-2rem))] max-w-[90vw] min-h-0 flex-col overflow-hidden p-3">
  <div class="flex shrink-0 items-center justify-between gap-2">
    <div class="flex min-w-0 items-center gap-1.5">
      <GitCommitHorizontal class="size-3.5 text-muted-foreground" />
      <span class="truncate text-xs font-medium text-foreground">Review range</span>
    </div>
    <Button
      variant="ghost"
      size="xs"
      onclick={onClose}
      aria-label="Close commit picker"
      title="Close"
    >
      <X class="size-3" />
    </Button>
  </div>

  <label class="mt-2 flex shrink-0 items-center gap-2 text-xs text-foreground">
    <input
      type="checkbox"
      class="size-3"
      checked={includeWt}
      onchange={(e) => (includeWt = (e.currentTarget as HTMLInputElement).checked)}
    />
    Include working tree
  </label>

  <div class="mt-2 flex shrink-0 flex-col gap-1">
    <label
      for="commit-picker-from-ref"
      class="flex items-center gap-1 text-[10px] text-muted-foreground"
    >
      From ref (optional)
    </label>
    <div class="flex items-center gap-1">
      <Input
        id="commit-picker-from-ref"
        value={fromRef}
        oninput={updateFromRef}
        placeholder="HEAD~5, main, or a SHA"
        class="h-7 min-w-0 flex-1 text-xs"
      />
      {#if selectedBranch}
        <Button
          variant="ghost"
          size="xs"
          onclick={clearFromRef}
          aria-label="Clear selected branch"
          title="Clear selected branch"
        >
          <X class="size-3" />
        </Button>
      {/if}
    </div>
    <span class="text-[10px] text-muted-foreground">
      {#if selectedBranch}
        Reviewing current HEAD from <span class="font-mono">{selectedBranch}</span>. Select commits below to narrow the range.
      {:else}
        Select a branch ref in the history below, or enter a ref manually.
      {/if}
    </span>
    {#if branches.length > 0}
      <div class="mt-1 flex flex-col gap-1">
        <span class="text-[10px] text-muted-foreground">Branches</span>
        <ScrollArea orientation="horizontal" class="w-full">
          <div class="flex gap-1 pb-1">
            {#each branches as branch (branch.name)}
              <button
                type="button"
                class={`inline-flex h-5 max-w-48 shrink-0 items-center gap-1 rounded border px-1.5 text-[9px] ${
                  selectedBranch === branch.name
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground'
                }`}
                title={`Review current HEAD from ${branch.name}`}
                disabled={applying}
                onclick={() => void chooseBranch(branch.name)}
              >
                {#if selectedBranch === branch.name}
                  <Check class="size-2.5 shrink-0" />
                {:else}
                  <GitBranch class="size-2.5 shrink-0" />
                {/if}
                <span class="truncate">{branch.name}</span>
                {#if branch.current}
                  <span class="text-[8px] text-muted-foreground">current</span>
                {/if}
              </button>
            {/each}
          </div>
        </ScrollArea>
      </div>
    {/if}
  </div>

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
      <div class="inline-flex rounded-md border border-border bg-muted/30 p-0.5" aria-label="Result type">
        {#each [
          ['all', 'All'],
          ['branches', 'Branches'],
          ['commits', 'Commits']
        ] as option (option[0])}
          <button
            type="button"
            class={`rounded px-2 py-1 transition-colors ${
              resultFilter === option[0]
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            aria-pressed={resultFilter === option[0]}
            onclick={() => (resultFilter = option[0] as GitHistoryFilter)}
          >
            {option[1]}
          </button>
        {/each}
      </div>
      <div class="flex items-center gap-1">
        <span>{selected.size} selected</span>
        <button
          type="button"
          class="rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
          onclick={selectAll}
        >
          All
        </button>
        <button
          type="button"
          class="rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
          onclick={clearSelection}
        >
          Clear
        </button>
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
            class="mt-2 underline underline-offset-2"
            onclick={() => void loadHistory()}
          >
            Retry
          </button>
        </div>
      </div>
    {:else if branchLoading && selectedBranch}
      <div class="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 class="size-3 animate-spin" />
        Loading commits from {selectedBranch}…
      </div>
    {:else if graphRows.length === 0}
      <div class="flex items-center gap-2 px-4 py-8 text-center text-xs text-muted-foreground">
        <History class="mx-auto size-3" />
        <span>
          {#if selectedBranch && branchCommitHashes}
            No commits between {selectedBranch} and HEAD.
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
              <input
                type="checkbox"
                class="size-3 shrink-0"
                checked={isSelected}
                onchange={() => toggle(row.commit.hash)}
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
                  <button
                    type="button"
                    class={`inline-flex h-5 min-w-0 items-center gap-1 rounded border px-1.5 text-[9px] ${
                      selectedBranch === ref.name
                        ? 'border-primary/50 bg-primary/10 text-foreground'
                        : 'border-border bg-background text-muted-foreground hover:text-foreground'
                    }`}
                    title={`Use ${ref.kind} ${ref.name} as the comparison base`}
                    disabled={applying}
                    onclick={() => void chooseBranch(ref.name)}
                  >
                    {#if selectedBranch === ref.name}
                      <Check class="size-2.5 shrink-0" />
                    {:else}
                      <RefIcon class="size-2.5 shrink-0" />
                    {/if}
                    <span class="max-w-32 truncate">{ref.name}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </ScrollArea>

  {#if branchError}
    <div class="mt-1.5 flex shrink-0 items-start gap-1 text-[10px] text-destructive">
      <AlertCircle class="size-3 shrink-0" />
      <span class="break-words">{branchError}</span>
    </div>
  {/if}

  {#if resolveError}
    <div class="mt-1.5 flex shrink-0 items-start gap-1 text-[10px] text-destructive">
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
      Clear
    </Button>
    <Button size="xs" onclick={() => void apply()} disabled={applying}>
      {#if applying}
        <Loader2 class="mr-1 size-3 animate-spin" />
      {/if}
      Apply
    </Button>
  </div>
</div>
