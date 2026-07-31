<script lang="ts">
  import {
    AlertCircle,
    Check,
    GitBranch,
    Loader2,
    Search,
    Tag
  } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type {
    GitHistoryCommit,
    GitHistoryRef,
    GitStatus
  } from '@shared/types/git.js';
  import type { RunMode } from '@shared/types/sessions.js';
  import {
    buildGitHistoryGraph,
    filterGitHistory,
    type GitHistoryFilter
  } from '../lib/git-history-graph';
  import { ipc } from '../lib/ipc';
  import { git } from '../stores/git.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Popover from '$lib/components/ui/popover';
  import GitIdentityLabel from './GitIdentityLabel.svelte';

  let { cwd, runMode, wslDistro }: {
    cwd: string;
    runMode?: RunMode;
    wslDistro?: string;
  } = $props();

  const INITIAL_HISTORY_LIMIT = 100;
  const HISTORY_STEP = 100;
  const LANE_WIDTH = 12;
  const LANE_COLORS = [
    'var(--primary)',
    '#22c55e',
    '#f59e0b',
    '#a855f7',
    '#06b6d4',
    '#f43f5e'
  ];

  let context = $derived({
    ...(runMode ? { runMode } : {}),
    ...(wslDistro ? { wslDistro } : {})
  });
  let status = $derived(git.statusFor(cwd, context));
  let shortstat = $derived(git.shortstatFor(cwd, context));
  let switcherOpen = $state(false);
  let history = $state<GitHistoryCommit[]>([]);
  let historyStatus = $state<GitStatus | null>(null);
  let historyLimit = $state(INITIAL_HISTORY_LIMIT);
  let query = $state('');
  let resultFilter = $state<GitHistoryFilter>('all');
  let checkingOut = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let loadGeneration = 0;

  let filteredHistory = $derived(filterGitHistory(history, query, resultFilter));
  let graphRows = $derived(buildGitHistoryGraph(filteredHistory));
  let maxLanes = $derived(
    Math.max(1, ...graphRows.map((row) => Math.max(row.laneCount, row.nextLaneCount)))
  );
  let graphWidth = $derived(maxLanes * LANE_WIDTH + 8);

  async function refresh(force = false): Promise<GitStatus | null> {
    const next = await git.loadStatus(cwd, force, context);
    if (next?.repoPath) void git.loadShortstat(next.repoPath, force, context);
    return next;
  }

  $effect(() => {
    void cwd;
    void runMode;
    void wslDistro;
    untrack(() => {
      loadGeneration += 1;
      historyStatus = null;
      history = [];
      void refresh(false);
    });
  });

  let shortHead = $derived(status?.head ? status.head.slice(0, 7) : null);
  let label = $derived.by<string | null>(() => {
    if (!status || !status.isRepo) return null;
    if (status.detached) return shortHead ?? 'detached';
    return status.branch ?? null;
  });
  let worktreeName = $derived(
    baseName(historyStatus?.repoPath ?? status?.repoPath ?? cwd)
  );
  let badge = $derived.by<string>(() => {
    if (!status || !status.isRepo) return '';
    const dirty = status.dirty ? '●' : '';
    const ahead = status.ahead > 0 ? `↑${status.ahead}` : '';
    const behind = status.behind > 0 ? `↓${status.behind}` : '';
    return [dirty, ahead, behind].filter(Boolean).join(' ');
  });
  let hasDiff = $derived(
    !!shortstat && shortstat.isRepo && (shortstat.insertions > 0 || shortstat.deletions > 0)
  );
  let title = $derived.by<string>(() => {
    if (!status || !status.isRepo) return 'Not a git repository';
    const parts = [`Worktree: ${status.repoPath ?? cwd}`];
    if (status.staged > 0) parts.push(`${status.staged} staged`);
    if (status.unstaged > 0) parts.push(`${status.unstaged} unstaged`);
    if (status.untracked > 0) parts.push(`${status.untracked} untracked`);
    if (parts.length === 1) parts.push('clean');
    if (status.ahead > 0) parts.push(`ahead ${status.ahead}`);
    if (status.behind > 0) parts.push(`behind ${status.behind}`);
    return parts.join(' · ');
  });

  $effect(() => {
    const open = switcherOpen;
    const limit = historyLimit;
    void cwd;
    void runMode;
    void wslDistro;
    if (!open) {
      loadGeneration += 1;
      untrack(() => {
        historyLimit = INITIAL_HISTORY_LIMIT;
        query = '';
        resultFilter = 'all';
        loadError = null;
      });
      return;
    }
    untrack(() => void loadHistory(limit));
  });

  async function loadHistory(limit: number): Promise<void> {
    const generation = ++loadGeneration;
    loading = true;
    loadError = null;
    try {
      const nextStatus = await refresh(true);
      if (generation !== loadGeneration) return;
      if (!nextStatus?.repoPath) throw new Error('Not a git repository');
      historyStatus = nextStatus;
      const nextHistory = await ipc.git.refHistory({
        repoPath: nextStatus.repoPath,
        limit,
        force: true,
        ...git.contextFor(cwd, context)
      });
      if (generation !== loadGeneration) return;
      history = nextHistory;
    } catch (err) {
      if (generation !== loadGeneration) return;
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  async function checkout(ref: string): Promise<void> {
    const activeStatus = historyStatus ?? status;
    if (!activeStatus?.repoPath || checkingOut) return;
    checkingOut = ref;
    try {
      const next = await ipc.git.checkout({
        repoPath: activeStatus.repoPath,
        ref,
        ...git.contextFor(cwd, context)
      });
      git.setStatus(activeStatus.cwd, next, context);
      switcherOpen = false;
    } catch (err) {
      reportError(err);
    } finally {
      checkingOut = null;
    }
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

  function baseName(path: string): string {
    const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts.at(-1) || path;
  }

  function formattedDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }
</script>

{#if label}
  <div class="inline-flex min-w-0 items-center">
    <Popover.Root bind:open={switcherOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="outline"
            size="xs"
            class={`min-w-0 gap-1.5 ${status?.dirty ? 'text-foreground' : ''}`}
            {title}
          >
            <GitIdentityLabel
              branch={label}
              worktree={worktreeName}
              detached={status?.detached}
            />
            {#if badge}
              <span class={`text-[10px] ${status?.dirty ? 'text-amber-500' : 'text-muted-foreground'}`}>
                {badge}
              </span>
            {/if}
            {#if hasDiff && shortstat}
              <span class="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums">
                {#if shortstat.insertions > 0}
                  <span class="text-emerald-500">+{shortstat.insertions}</span>
                {/if}
                {#if shortstat.deletions > 0}
                  <span class="text-rose-500">−{shortstat.deletions}</span>
                {/if}
              </span>
            {/if}
          </Button>
        {/snippet}
      </Popover.Trigger>

      <Popover.Content
        align="start"
        class="mobile-branch-popover flex h-[min(34rem,calc(100vh-4rem))] w-[min(46rem,calc(100vw-2rem))] min-h-0 flex-col overflow-hidden p-0"
      >
        <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <GitIdentityLabel
            branch={label}
            worktree={worktreeName}
            path={historyStatus?.repoPath ?? status?.repoPath ?? cwd}
            detached={status?.detached}
            variant="detail"
          />
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2">
          <div class="mobile-branch-search relative min-w-[12rem] flex-1">
            <Search class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              bind:value={query}
              class="h-7 pl-7 text-[11px]"
              placeholder="Search branches, commits, authors, or hashes…"
              aria-label="Search branches and commits"
            />
          </div>
          <div class="inline-flex rounded-md border border-border bg-muted/30 p-0.5" aria-label="Result type">
            {#each [
              ['all', 'All'],
              ['branches', 'Branches'],
              ['commits', 'Commits']
            ] as option (option[0])}
              <button
                type="button"
                class={`rounded px-2 py-1 text-[10px] transition-colors ${
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
        </div>

        <ScrollArea class="min-h-0 flex-1">
          {#if loading && history.length === 0}
            <div class="flex items-center gap-2 px-4 py-8 text-xs text-muted-foreground">
              <Loader2 class="size-3 animate-spin" />
              Loading branches and commits…
            </div>
          {:else if loadError && history.length === 0}
            <div class="flex items-start gap-2 px-4 py-8 text-xs text-destructive">
              <AlertCircle class="mt-0.5 size-3 shrink-0" />
              <div class="min-w-0">
                <div class="break-words">{loadError}</div>
                <button
                  type="button"
                  class="mt-2 underline underline-offset-2"
                  onclick={() => loadHistory(historyLimit)}
                >
                  Retry
                </button>
              </div>
            </div>
          {:else if graphRows.length === 0}
            <div class="px-4 py-8 text-center text-xs text-muted-foreground">
              No matching branches or commits
            </div>
          {:else}
            <div class="py-1">
              {#each graphRows as row (row.commit.hash)}
                <div class="group flex min-h-11 items-stretch border-b border-border/40 last:border-b-0 hover:bg-muted/40">
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

                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
                    disabled={checkingOut !== null || status?.head === row.commit.hash}
                    onclick={() => checkout(row.commit.hash)}
                  >
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
                    {#if status?.head === row.commit.hash}
                      <Check class="size-3 shrink-0 text-primary" />
                    {/if}
                  </button>

                  {#if row.commit.refs.length > 0}
                    <div class="mobile-branch-refs flex max-w-[46%] flex-wrap items-center justify-end gap-1 py-1.5 pr-2">
                      {#each row.commit.refs as ref (`${ref.kind}:${ref.name}`)}
                        {@const RefIcon = refIcon(ref)}
                        <button
                          type="button"
                          class={`inline-flex h-5 min-w-0 items-center gap-1 rounded border px-1.5 text-[9px] ${
                            ref.current
                              ? 'border-primary/50 bg-primary/10 text-foreground'
                              : 'border-border bg-background text-muted-foreground hover:text-foreground'
                          }`}
                          disabled={ref.current || checkingOut !== null}
                          title={`${ref.kind}: ${ref.name}`}
                          onclick={() => checkout(ref.name)}
                        >
                          <RefIcon class="size-2.5 shrink-0" />
                          <span class="max-w-32 truncate">{ref.name}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
              {#if history.length >= historyLimit}
                <button
                  type="button"
                  class="flex h-9 w-full items-center justify-center gap-2 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  disabled={loading || checkingOut !== null}
                  onclick={() => (historyLimit += HISTORY_STEP)}
                >
                  {#if loading}<Loader2 class="size-3 animate-spin" />{/if}
                  Show {HISTORY_STEP} more
                </button>
              {/if}
            </div>
          {/if}
        </ScrollArea>
      </Popover.Content>
    </Popover.Root>
  </div>
{/if}
