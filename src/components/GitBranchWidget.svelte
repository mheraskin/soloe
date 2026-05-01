<script lang="ts">
  import { GitBranch, RotateCw } from 'lucide-svelte';
  import { git } from '../stores/git.svelte';
  import BranchSwitcher from './BranchSwitcher.svelte';

  let { cwd }: { cwd: string } = $props();
  let switcherOpen = $state(false);

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
</script>

{#if label}
  <span class="wrap">
    <button
      class="git"
      class:dirty={status?.dirty}
      onclick={() => (switcherOpen = !switcherOpen)}
      disabled={loading}
      {title}
    >
      <GitBranch size={12} />
      <span class="branch">{label}</span>
      {#if badge}<span class="badge">{badge}</span>{/if}
    </button>
    <button
      class="refresh"
      onclick={() => refresh(true)}
      disabled={loading}
      title="Refresh git status"
      aria-label="Refresh git status"
    >
      <RotateCw size={10} class={loading ? 'spin' : ''} />
    </button>
    {#if switcherOpen && status?.repoPath}
      <BranchSwitcher {status} onclose={() => (switcherOpen = false)} />
    {/if}
  </span>
{/if}

<style>
  .wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .git {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px 0 0 4px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--fg);
    font-size: 12px;
    cursor: pointer;
  }
  .git:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .refresh {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    padding: 2px 0;
    border-radius: 0 4px 4px 0;
    border-left: none;
    background: var(--bg-elev-2);
    color: var(--muted);
  }
  .refresh:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .branch {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    color: var(--muted);
    font-size: 11px;
  }
  .dirty .badge {
    color: var(--yellow, #d6a600);
  }
  :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
