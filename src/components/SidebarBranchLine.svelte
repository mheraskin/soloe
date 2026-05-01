<script lang="ts">
  import { GitBranch } from 'lucide-svelte';
  import { git } from '../stores/git.svelte';

  let { cwd }: { cwd: string } = $props();

  $effect(() => {
    void git.loadStatus(cwd);
  });

  let status = $derived(git.statusFor(cwd));
  let label = $derived.by<string | null>(() => {
    if (!status?.isRepo) return null;
    if (status.detached) return 'detached';
    return status.branch;
  });
  let counts = $derived.by<string>(() => {
    if (!status?.isRepo) return '';
    const ahead = status.ahead > 0 ? `↑${status.ahead}` : '';
    const behind = status.behind > 0 ? `↓${status.behind}` : '';
    return [ahead, behind].filter(Boolean).join(' ');
  });
</script>

{#if label}
  <span class="branch" title={status?.dirty ? 'Git working tree has changes' : 'Git working tree is clean'}>
    <GitBranch size={10} />
    <span class="name">{label}</span>
    {#if counts}<span>{counts}</span>{/if}
    {#if status?.dirty}<span class="dirty"></span>{/if}
  </span>
{/if}

<style>
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    color: var(--muted-2);
    font-size: 10px;
    font-family: var(--font-mono);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 110px;
  }
  .dirty {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--amber);
    flex-shrink: 0;
  }
</style>
