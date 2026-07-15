<script lang="ts">
  import { Loader2, AlertCircle, History, X } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { GitCommit } from '@shared/types/git.js';
  import { worktreeRuntimeContext } from '@shared/worktree-identity.js';
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

  const RECENT_LIMIT = 50;

  let {
    scope,
    onClose
  }: {
    scope: ReviewScope;
    onClose: () => void;
  } = $props();
  let cwd = $derived(scope.cwd);

  let commits = $state<GitCommit[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

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

  // Pull the repoPath from the git store; recentCommits is keyed by repo,
  // not cwd, so multiple worktrees of the same repo share commit history.
  $effect(() => {
    const status = git.statusFor(scope);
    const repoPath = status?.repoPath;
    if (!repoPath) {
      commits = [];
      return;
    }
    loading = true;
    error = null;
    const ctx = worktreeRuntimeContext(scope);
    ipc.git
      .recentCommits({
        repoPath,
        limit: RECENT_LIMIT,
        force: true,
        ...ctx
      })
      .then((next) => {
        commits = next;
      })
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        loading = false;
      });
  });

  function toggle(hash: string): void {
    if (selected.has(hash)) selected.delete(hash);
    else selected.add(hash);
  }

  function selectAll(): void {
    selected.clear();
    for (const c of commits) selected.add(c.hash);
  }

  function clearSelection(): void {
    selected.clear();
  }

  async function apply(): Promise<void> {
    if (applying) return;
    if (selected.size === 0 && !fromRef.trim()) {
      resolveError = 'Pick at least one commit or enter a from-ref.';
      return;
    }
    applying = true;
    resolveError = null;
    try {
      const ctx = worktreeRuntimeContext(scope);
      // Resolve the from-ref upfront so a bad input fails loudly. When the
      // user picks commits without a from-ref, base is the parent of the
      // oldest selection.
      let resolvedBase: string | null = null;
      let resolvedHead: string | null = null;

      const orderedHashes = commits
        .filter((c) => selected.has(c.hash))
        .map((c) => c.hash);
      // `commits` comes back newest-first from recentCommits; we want oldest
      // first to compute the parent of the earliest commit.
      orderedHashes.reverse();

      if (fromRef.trim()) {
        const refs = [fromRef.trim(), 'HEAD'];
        const resolved = await ipc.git.resolveRefs({ cwd, refs, ...ctx });
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
        if (!resolvedBase) {
          resolveError = "Couldn't resolve the parent of the earliest commit.";
          applying = false;
          return;
        }
      }

      if (!resolvedBase || !resolvedHead) {
        resolveError = 'Range incomplete.';
        applying = false;
        return;
      }

      // Topo-order the full range so chip rendering uses git's ordering, not
      // recent-commits sort. We re-fetch even when the user only picked
      // checkboxes: a range may legitimately span commits older than the
      // recent-50 window if the from-ref points further back.
      const { commits: ordered, truncated } = await ipc.git.commitsBetween({
        cwd,
        base: resolvedBase,
        head: resolvedHead,
        ...ctx
      });
      if (truncated) {
        reportError(
          `Range hit the 500-commit cap; only the first 500 will be tracked.`
        );
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
    fromRef = '';
    resolveError = null;
    onClose();
  }
</script>

<div class="flex w-80 max-w-[90vw] flex-col gap-2 p-3">
  <div class="flex items-center justify-between">
    <span class="text-xs font-medium text-foreground">Review range</span>
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

  <label class="flex items-center gap-2 text-xs text-foreground">
    <input
      type="checkbox"
      class="size-3"
      checked={includeWt}
      onchange={(e) => (includeWt = (e.currentTarget as HTMLInputElement).checked)}
    />
    Include working tree
  </label>

  <div class="flex flex-col gap-1">
    <label
      for="commit-picker-from-ref"
      class="flex items-center gap-1 text-[10px] text-muted-foreground"
    >
      From ref (optional)
    </label>
    <Input
      id="commit-picker-from-ref"
      bind:value={fromRef}
      placeholder="HEAD~5, main, or a SHA"
      class="h-7 text-xs"
    />
    <span class="text-[10px] text-muted-foreground">
      Overrides the parent-of-earliest default.
    </span>
  </div>

  <div class="flex items-center justify-between gap-1 text-[10px] text-muted-foreground">
    <span>Recent commits</span>
    <div class="flex items-center gap-1">
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

  <ScrollArea class="h-56 rounded border border-border">
    <div class="flex flex-col gap-px p-1">
      {#if loading && commits.length === 0}
        <div class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <Loader2 class="size-3 animate-spin" />
          Loading commits…
        </div>
      {:else if error}
        <div class="flex items-start gap-2 px-2 py-3 text-xs text-destructive">
          <AlertCircle class="size-3 shrink-0" />
          <span class="break-words">{error}</span>
        </div>
      {:else if commits.length === 0}
        <div class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <History class="size-3" />
          No commits available.
        </div>
      {:else}
        {#each commits as commit (commit.hash)}
          {@const isSelected = selected.has(commit.hash)}
          <label
            class={[
              'flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs',
              isSelected ? 'bg-muted' : 'hover:bg-muted/60'
            ]}
          >
            <input
              type="checkbox"
              class="size-3"
              checked={isSelected}
              onchange={() => toggle(commit.hash)}
            />
            <code class="shrink-0 font-mono text-[10px] text-muted-foreground">
              {commit.shortHash}
            </code>
            <span class="truncate text-foreground" title={commit.subject}>
              {commit.subject}
            </span>
          </label>
        {/each}
      {/if}
    </div>
  </ScrollArea>

  {#if resolveError}
    <div class="flex items-start gap-1 text-[10px] text-destructive">
      <AlertCircle class="size-3 shrink-0" />
      <span class="break-words">{resolveError}</span>
    </div>
  {/if}

  <div class="flex items-center justify-between gap-2 pt-1">
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
