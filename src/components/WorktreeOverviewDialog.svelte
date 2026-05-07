<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import WorktreeOverviewView from './WorktreeOverviewView.svelte';

  interface Props {
    open: boolean;
    cwd: string;
    branch: string;
    baseBranch?: string;
  }

  let { open = $bindable(false), cwd, branch, baseBranch }: Props = $props();
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
      <WorktreeOverviewView {cwd} {baseBranch} />
    </div>
  </Dialog.Content>
</Dialog.Root>
