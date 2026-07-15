<script lang="ts">
  import { AlertCircle, Loader2, RefreshCw } from '@lucide/svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { LazyModule } from '../lib/lazy-module.svelte';

  type OverviewComponent = typeof import('./WorktreeOverviewView.svelte').default;

  interface Props {
    open: boolean;
    cwd: string;
    branch: string;
    baseBranch?: string;
  }

  let { open = $bindable(false), cwd, branch, baseBranch }: Props = $props();
  const overviewView = new LazyModule<OverviewComponent>(() =>
    import('./WorktreeOverviewView.svelte').then((module) => module.default)
  );

  $effect(() => {
    if (open) void overviewView.load();
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="flex h-[80vh] max-h-[800px] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
    <Dialog.Header class="border-b border-border px-3 py-2">
      <Dialog.Title class="font-mono text-sm">{branch}</Dialog.Title>
      <Dialog.Description class="truncate font-mono text-[11px] text-muted-foreground" title={cwd}>
        {cwd}
      </Dialog.Description>
    </Dialog.Header>
    <div class="min-h-0 flex-1">
      {#if overviewView.value}
        {@const LoadedOverview = overviewView.value}
        <LoadedOverview {cwd} {baseBranch} />
      {:else if overviewView.error}
        <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertCircle class="size-5 text-destructive" />
          <div class="space-y-1">
            <p class="text-sm font-medium">Could not load the worktree overview</p>
            <p class="max-w-96 text-xs text-muted-foreground">{overviewView.error.message}</p>
          </div>
          <Button variant="outline" size="sm" onclick={() => void overviewView.load()}>
            <RefreshCw class="size-3.5" />
            Retry
          </Button>
        </div>
      {:else}
        <div class="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" aria-busy="true">
          <Loader2 class="size-4 animate-spin" />
          Loading overview…
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
