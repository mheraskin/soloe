<script lang="ts">
  import { FolderGit2, GitBranch, GitCommitHorizontal } from '@lucide/svelte';
  import { gitIdentityParts } from '../lib/git-identity';

  let {
    branch,
    worktree,
    path = null,
    detached = false,
    variant = 'compact'
  }: {
    branch: string;
    worktree: string;
    path?: string | null;
    detached?: boolean;
    variant?: 'compact' | 'detail';
  } = $props();

  let identity = $derived(gitIdentityParts(branch, worktree, detached));
  let branchPart = $derived(identity[0]);
  let worktreePart = $derived(identity[1]);
</script>

{#if variant === 'compact'}
  {#if branchPart.icon === 'commit'}
    <GitCommitHorizontal />
  {:else}
    <GitBranch />
  {/if}
  <span class={`max-w-[130px] truncate font-medium ${detached ? 'font-mono' : ''}`}>
    {branchPart.label}
  </span>
  <span class="text-muted-foreground/50" aria-hidden="true">/</span>
  <FolderGit2 class="size-3 shrink-0 text-muted-foreground" />
  <span class="max-w-[110px] truncate text-muted-foreground">{worktreePart.label}</span>
{:else}
  {#if branchPart.icon === 'commit'}
    <GitCommitHorizontal class="size-4 text-muted-foreground" />
  {:else}
    <GitBranch class="size-4 text-muted-foreground" />
  {/if}
  <div class="min-w-0 flex-1">
    <div class={`truncate text-xs font-medium ${detached ? 'font-mono' : ''}`}>
      {branchPart.label}
    </div>
    <div class="flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground">
      <FolderGit2 class="size-3 shrink-0" />
      <span class="shrink-0">{worktreePart.label}</span>
      {#if path}
        <span class="text-muted-foreground/50" aria-hidden="true">·</span>
        <span class="truncate text-muted-foreground/65">{path}</span>
      {/if}
    </div>
  </div>
{/if}
