<script lang="ts">
  import { AlertCircle, Check, GitBranch, GitCommitHorizontal, Loader2 } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import type { GitBranch as GitBranchInfo, GitCommit } from '@shared/types/git.js';
  import type { RunMode } from '@shared/types/sessions.js';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';
  import { git } from '../stores/git.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as Popover from '$lib/components/ui/popover';
  import * as Command from '$lib/components/ui/command';

  let { cwd, runMode, wslDistro }: {
    cwd: string;
    runMode?: RunMode;
    wslDistro?: string;
  } = $props();

  let context = $derived({
    ...(runMode ? { runMode } : {}),
    ...(wslDistro ? { wslDistro } : {})
  });

  const INITIAL_COMMIT_LIMIT = 10;

  let switcherOpen = $state(false);
  let branches = $state<GitBranchInfo[]>([]);
  let commits = $state<GitCommit[]>([]);
  let commitLimit = $state<number | null>(INITIAL_COMMIT_LIMIT);
  let checkingOut = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  async function refresh(force = false): Promise<void> {
    const status = await git.loadStatus(cwd, force, context);
    if (status?.repoPath) void git.loadShortstat(status.repoPath, force, context);
  }

  $effect(() => {
    void cwd;
    untrack(() => {
      void refresh(false);
    });
  });

  let status = $derived(git.statusFor(cwd, context));
  let shortstat = $derived(git.shortstatFor(cwd, context));

  let shortHead = $derived(status?.head ? status.head.slice(0, 7) : null);

  let label = $derived.by<string | null>(() => {
    if (!status || !status.isRepo) return null;
    if (status.detached) return shortHead ?? 'detached';
    return status.branch ?? null;
  });

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
    const parts: string[] = [];
    if (status.staged > 0) parts.push(`${status.staged} staged`);
    if (status.unstaged > 0) parts.push(`${status.unstaged} unstaged`);
    if (status.untracked > 0) parts.push(`${status.untracked} untracked`);
    if (parts.length === 0) parts.push('clean');
    if (status.ahead > 0) parts.push(`ahead ${status.ahead}`);
    if (status.behind > 0) parts.push(`behind ${status.behind}`);
    if (shortstat && shortstat.isRepo && (shortstat.insertions > 0 || shortstat.deletions > 0)) {
      parts.push(`${shortstat.filesChanged} files +${shortstat.insertions} −${shortstat.deletions}`);
    }
    return parts.join(' · ');
  });

  $effect(() => {
    if (!switcherOpen) {
      untrack(() => {
        commitLimit = INITIAL_COMMIT_LIMIT;
        loadError = null;
      });
      return;
    }
    if (!status?.repoPath) return;
    const repoPath = status.repoPath;
    const ctx = git.contextFor(cwd, context);
    const limit = commitLimit;
    untrack(() => {
      loading = true;
      loadError = null;
    });
    Promise.all([
      ipc.git.branches({ repoPath, force: true, ...ctx }),
      ipc.git.recentCommits({
        repoPath,
        force: true,
        ...(limit === null ? {} : { limit }),
        ...ctx
      })
    ])
      .then(([nextBranches, nextCommits]) => {
        branches = nextBranches;
        commits = nextCommits;
        loading = false;
      })
      .catch((err) => {
        loading = false;
        loadError = err instanceof Error ? err.message : String(err);
        reportError(err);
      });
  });

  function loadAllCommits() {
    commitLimit = null;
  }

  async function checkout(ref: string): Promise<void> {
    if (!status?.repoPath || checkingOut) return;
    checkingOut = ref;
    try {
      const next = await ipc.git.checkout({
        repoPath: status.repoPath,
        ref,
        ...git.contextFor(cwd, context)
      });
      git.setStatus(status.cwd, next, context);
      switcherOpen = false;
    } catch (err) {
      reportError(err);
    } finally {
      checkingOut = null;
    }
  }
</script>

{#if label}
  <div class="inline-flex items-center">
    <Popover.Root bind:open={switcherOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="outline"
            size="xs"
            class={`gap-1.5 ${status?.dirty ? 'text-foreground' : ''}`}
            {title}
          >
            {#if status?.detached}
              <GitCommitHorizontal />
            {:else}
              <GitBranch />
            {/if}
            <span class={`max-w-[160px] truncate ${status?.detached ? 'font-mono' : ''}`}>{label}</span>
            {#if badge}
              <span class={`text-[10px] ${status?.dirty ? 'text-amber-500' : 'text-muted-foreground'}`}>{badge}</span>
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
      <Popover.Content align="start" class="w-[36rem] p-0">
        <div class="flex divide-x divide-border">
          <Command.Root class="flex-1 rounded-none!">
            <Command.Input placeholder="Filter branches…" />
            <Command.List>
              {#if loading && branches.length === 0}
                <div class="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <Loader2 class="size-3 animate-spin" />
                  Loading branches…
                </div>
              {:else if loadError && branches.length === 0}
                <div class="flex items-start gap-2 px-3 py-4 text-xs text-destructive">
                  <AlertCircle class="size-3 shrink-0" />
                  <span class="break-words">{loadError}</span>
                </div>
              {:else}
                <Command.Empty>No branches</Command.Empty>
              {/if}
              {#if branches.length > 0}
                <Command.Group heading="Branches">
                  {#each branches as branch (branch.name)}
                    <Command.Item
                      value={branch.name}
                      disabled={branch.current || checkingOut !== null}
                      onSelect={() => checkout(branch.name)}
                    >
                      <span class="inline-flex w-3 shrink-0 items-center">
                        {#if branch.current}<Check class="size-3 text-primary" />{/if}
                      </span>
                      <span class="flex-1 truncate">{branch.name}</span>
                      {#if branch.upstream}
                        <Badge variant="outline" class="font-mono text-[10px]">{branch.upstream}</Badge>
                      {/if}
                    </Command.Item>
                  {/each}
                </Command.Group>
              {/if}
            </Command.List>
          </Command.Root>
          <Command.Root class="flex-1 rounded-none!">
            <Command.Input placeholder="Filter commits…" />
            <Command.List>
              {#if loading && commits.length === 0}
                <div class="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                  <Loader2 class="size-3 animate-spin" />
                  Loading commits…
                </div>
              {:else if loadError && commits.length === 0}
                <div class="flex items-start gap-2 px-3 py-4 text-xs text-destructive">
                  <AlertCircle class="size-3 shrink-0" />
                  <span class="break-words">{loadError}</span>
                </div>
              {:else}
                <Command.Empty>No commits</Command.Empty>
              {/if}
              {#if commits.length > 0}
                <Command.Group heading="Recent commits">
                  {#each commits as commit (commit.hash)}
                    {@const isCurrent = status?.detached && status.head === commit.hash}
                    <Command.Item
                      value={commit.hash}
                      disabled={isCurrent || checkingOut !== null}
                      onSelect={() => checkout(commit.hash)}
                    >
                      <span class="inline-flex w-3 shrink-0 items-center">
                        {#if isCurrent}<Check class="size-3 text-primary" />{/if}
                      </span>
                      <span class="w-12 shrink-0 truncate font-mono text-[10px] text-muted-foreground">{commit.shortHash}</span>
                      <span class="flex-1 truncate">{commit.subject}</span>
                    </Command.Item>
                  {/each}
                  {#if commitLimit !== null && commits.length >= commitLimit}
                    <Command.Item
                      value="__load_all_commits__"
                      forceMount
                      disabled={checkingOut !== null}
                      onSelect={loadAllCommits}
                    >
                      <span class="w-3 shrink-0"></span>
                      <span class="flex-1 truncate text-xs text-muted-foreground">Load all commits…</span>
                    </Command.Item>
                  {/if}
                </Command.Group>
              {/if}
            </Command.List>
          </Command.Root>
        </div>
      </Popover.Content>
    </Popover.Root>
  </div>
{/if}
