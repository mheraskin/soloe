<script lang="ts">
  import { Check, GitBranch } from 'lucide-svelte';
  import type { GitBranch as GitBranchInfo, GitCommit, GitStatus } from '@shared/types/git.js';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';
  import { git } from '../stores/git.svelte';

  let {
    status,
    onclose
  }: {
    status: GitStatus;
    onclose: () => void;
  } = $props();

  let branches = $state<GitBranchInfo[]>([]);
  let commits = $state<GitCommit[]>([]);
  let loading = $state(false);
  let checkingOut = $state<string | null>(null);

  $effect(() => {
    const repoPath = status.repoPath;
    if (!repoPath) return;
    loading = true;
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
        loading = false;
      });
  });

  async function checkout(ref: string): Promise<void> {
    if (!status.repoPath || checkingOut) return;
    checkingOut = ref;
    try {
      const next = await ipc.git.checkout({ repoPath: status.repoPath, ref });
      git.setStatus(status.cwd, next);
      onclose();
    } catch (err) {
      reportError(err);
    } finally {
      checkingOut = null;
    }
  }
</script>

<svelte:window onclick={onclose} onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div
  class="switcher"
  role="dialog"
  aria-label="Switch branch"
  tabindex="-1"
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => e.stopPropagation()}
>
  <div class="heading">
    <GitBranch size={13} />
    <span>Switch branch</span>
  </div>

  {#if loading}
    <p class="empty">Loading…</p>
  {:else}
    <div class="section">Branches</div>
    {#if branches.length === 0}
      <p class="empty">No local branches</p>
    {:else}
      {#each branches as branch (branch.name)}
        <button
          class="row"
          class:current={branch.current}
          disabled={branch.current || checkingOut !== null}
          onclick={() => checkout(branch.name)}
          title={branch.lastCommit ?? branch.name}
        >
          <span class="mark">{#if branch.current}<Check size={12} />{/if}</span>
          <span class="label">{branch.name}</span>
          {#if branch.upstream}<span class="hint">{branch.upstream}</span>{/if}
        </button>
      {/each}
    {/if}

    <div class="section">Recent commits</div>
    {#if commits.length === 0}
      <p class="empty">No commits</p>
    {:else}
      {#each commits as commit (commit.hash)}
        <button
          class="row"
          disabled={checkingOut !== null}
          onclick={() => checkout(commit.hash)}
          title={commit.subject}
        >
          <span class="mark">{commit.shortHash}</span>
          <span class="label">{commit.subject}</span>
        </button>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .switcher {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 60;
    width: 280px;
    max-height: 360px;
    overflow-y: auto;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 6px;
  }
  .heading {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    color: var(--fg-strong);
    font-size: 12px;
    font-weight: 600;
  }
  .section {
    padding: 8px 8px 4px;
    color: var(--muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .row {
    width: 100%;
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    padding: 6px 8px;
    color: var(--fg);
    text-align: left;
  }
  .row:hover:not(:disabled) {
    background: var(--bg-elev-3);
  }
  .row.current {
    color: var(--accent);
  }
  .mark {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 10px;
    min-width: 0;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    color: var(--muted-2);
    font-size: 10px;
    font-family: var(--font-mono);
  }
  .empty {
    margin: 0;
    padding: 8px;
    color: var(--muted-2);
    font-size: 11px;
  }
</style>
