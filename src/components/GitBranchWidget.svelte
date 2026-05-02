<script lang="ts">
  import { Check, GitBranch, RotateCw } from '@lucide/svelte';
  import type { GitBranch as GitBranchInfo, GitCommit } from '@shared/types/git.js';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';
  import { git } from '../stores/git.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as Popover from '$lib/components/ui/popover';
  import * as Command from '$lib/components/ui/command';

  let { cwd }: { cwd: string } = $props();

  let switcherOpen = $state(false);
  let branches = $state<GitBranchInfo[]>([]);
  let commits = $state<GitCommit[]>([]);
  let switcherLoading = $state(false);
  let checkingOut = $state<string | null>(null);

  function refresh(force = false): void {
    void git.loadStatus(cwd, force);
  }

  $effect(() => {
    refresh();
    const interval = window.setInterval(() => refresh(true), 1500);
    return () => window.clearInterval(interval);
  });

  let status = $derived(git.statusFor(cwd));
  let loading = $derived(git.loadingFor(cwd));

  let label = $derived.by<string | null>(() => {
    if (!status || !status.isRepo) return null;
    if (status.detached) return 'detached';
    return status.branch ?? null;
  });

  let badge = $derived.by<string>(() => {
    if (!status || !status.isRepo) return '';
    const dirty = status.dirty ? '●' : '';
    const ahead = status.ahead > 0 ? `↑${status.ahead}` : '';
    const behind = status.behind > 0 ? `↓${status.behind}` : '';
    return [dirty, ahead, behind].filter(Boolean).join(' ');
  });

  let title = $derived.by<string>(() => {
    if (!status || !status.isRepo) return 'Not a git repository';
    const parts: string[] = [];
    if (status.staged > 0) parts.push(`${status.staged} staged`);
    if (status.unstaged > 0) parts.push(`${status.unstaged} unstaged`);
    if (status.untracked > 0) parts.push(`${status.untracked} untracked`);
    if (parts.length === 0) parts.push('clean');
    if (status.ahead > 0) parts.push(`ahead ${status.ahead}`);
    if (status.behind > 0) parts.push(`behind ${status.behind}`);
    return parts.join(' · ');
  });

  $effect(() => {
    if (!switcherOpen || !status?.repoPath) return;
    const repoPath = status.repoPath;
    switcherLoading = true;
    Promise.all([
      ipc.git.branches({ repoPath }),
      ipc.git.recentCommits({ repoPath, limit: 8 })
    ])
      .then(([nextBranches, nextCommits]) => {
        branches = nextBranches;
        commits = nextCommits;
      })
      .catch(reportError)
      .finally(() => {
        switcherLoading = false;
      });
  });

  async function checkout(ref: string): Promise<void> {
    if (!status?.repoPath || checkingOut) return;
    checkingOut = ref;
    try {
      const next = await ipc.git.checkout({ repoPath: status.repoPath, ref });
      git.setStatus(status.cwd, next);
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
            class={`gap-1.5 rounded-r-none border-r-0 ${status?.dirty ? 'text-foreground' : ''}`}
            disabled={loading}
            {title}
          >
            <GitBranch />
            <span class="max-w-[160px] truncate">{label}</span>
            {#if badge}
              <span class={`text-[10px] ${status?.dirty ? 'text-amber-500' : 'text-muted-foreground'}`}>{badge}</span>
            {/if}
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content align="start" class="w-72 p-0">
        <Command.Root>
          <Command.Input placeholder="Switch branch…" />
          <Command.List>
            {#if switcherLoading}
              <Command.Empty>Loading…</Command.Empty>
            {:else}
              <Command.Empty>No matches</Command.Empty>
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
              {#if commits.length > 0}
                <Command.Group heading="Recent commits">
                  {#each commits as commit (commit.hash)}
                    <Command.Item
                      value={commit.hash}
                      disabled={checkingOut !== null}
                      onSelect={() => checkout(commit.hash)}
                    >
                      <span class="w-12 shrink-0 truncate font-mono text-[10px] text-muted-foreground">{commit.shortHash}</span>
                      <span class="flex-1 truncate">{commit.subject}</span>
                    </Command.Item>
                  {/each}
                </Command.Group>
              {/if}
            {/if}
          </Command.List>
        </Command.Root>
      </Popover.Content>
    </Popover.Root>
    <Button
      variant="outline"
      size="xs"
      class="rounded-l-none border-l-0 px-1.5"
      onclick={() => refresh(true)}
      disabled={loading}
      title="Refresh git status"
      aria-label="Refresh git status"
    >
      <RotateCw class={`size-2.5 ${loading ? 'animate-spin' : ''}`} />
    </Button>
  </div>
{/if}
