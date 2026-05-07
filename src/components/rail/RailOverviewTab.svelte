<script lang="ts">
  import { sessions } from '../../stores/sessions.svelte';
  import WorktreeOverviewView from '../WorktreeOverviewView.svelte';

  let selected = $derived(sessions.selected);
  let cwd = $derived(selected?.cwd ?? '');
</script>

{#if cwd}
  <WorktreeOverviewView {cwd} />
{:else}
  <div class="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
    Select a session to see its worktree overview.
  </div>
{/if}
