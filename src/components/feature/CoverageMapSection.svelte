<script lang="ts">
  import { ChevronRight, ExternalLink } from '@lucide/svelte';
  import type { BranchStatus, CoverageMapSnapshot } from '@shared/types/features.js';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import { Button } from '$lib/components/ui/button';

  interface Props {
    coverage: CoverageMapSnapshot;
    onToggleBranch: (branchId: string, next: BranchStatus) => void;
    onOpenFile: (relativePath: string) => void;
  }

  let { coverage, onToggleBranch, onOpenFile }: Props = $props();

  let total = $derived(
    coverage.counts.todo +
      coverage.counts.in_progress +
      coverage.counts.resolved +
      coverage.counts.deferred
  );

  const STATUS_CYCLE: Record<BranchStatus, BranchStatus> = {
    todo: 'in_progress',
    in_progress: 'resolved',
    resolved: 'deferred',
    deferred: 'todo'
  };

  const STATUS_LABEL: Record<BranchStatus, string> = {
    todo: '[ ]',
    in_progress: '[~]',
    resolved: '[x]',
    deferred: '[D]'
  };

  const STATUS_CLASS: Record<BranchStatus, string> = {
    todo: 'text-muted-foreground/80 border-border',
    in_progress: 'text-amber-500 border-amber-500/40',
    resolved: 'text-emerald-500 border-emerald-500/40',
    deferred: 'text-slate-400 border-slate-400/40'
  };
</script>

<Collapsible.Root open={true} class="rounded-md border border-border">
  <Collapsible.Trigger
    class="group flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs font-medium hover:bg-muted/40"
  >
    <span class="flex min-w-0 items-center gap-1.5">
      <ChevronRight
        class="size-3 shrink-0 text-muted-foreground transition-transform data-[state=open]:rotate-90 group-data-[state=open]:rotate-90"
      />
      <span class="font-medium text-foreground">Coverage map</span>
      {#if !coverage.exists}
        <span class="text-[10px] text-muted-foreground">(not started)</span>
      {/if}
    </span>
    <span class="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
      {#if coverage.exists && total > 0}
        <span class="text-emerald-500">{coverage.counts.resolved}</span>
        <span class="text-amber-500">{coverage.counts.in_progress}</span>
        <span class="text-muted-foreground/80">{coverage.counts.todo}</span>
        <span class="text-slate-400">{coverage.counts.deferred}</span>
        <span>/ {total}</span>
      {/if}
    </span>
  </Collapsible.Trigger>
  <Collapsible.Content class="border-t border-border">
    {#if !coverage.exists}
      <div class="px-3 py-3 text-[11px] text-muted-foreground">
        No coverage map at <span class="font-mono">{coverage.relativePath}</span>. Use
        <span class="font-mono">/grill-with-docs</span> to start grilling this thread.
      </div>
    {:else if coverage.error}
      <div class="px-3 py-3 text-[11px] text-destructive">
        Failed to read coverage map: {coverage.error}
      </div>
    {:else}
      <div class="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-2.5 py-2">
        <div class="flex min-w-0 flex-col">
          <span class="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
            Currently grilling
          </span>
          {#if coverage.currentlyGrilling}
            <span class="truncate text-[11px] text-foreground" title={coverage.currentlyGrilling.entry.label}>
              <span class="font-mono text-muted-foreground">{coverage.currentlyGrilling.entry.id}</span>
              <span>·</span>
              <span>{coverage.currentlyGrilling.entry.label || 'unlabeled branch'}</span>
            </span>
          {:else}
            <span class="text-[11px] text-muted-foreground">All branches resolved.</span>
          {/if}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open coverage map"
          title="Open coverage map in editor"
          onclick={() => onOpenFile(coverage.relativePath)}
        >
          <ExternalLink class="size-3" />
        </Button>
      </div>

      <div class="divide-y divide-border">
        {#each coverage.sections as section (section.id)}
          <details class="group" open>
            <summary
              class="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted/40"
            >
              <span class="flex items-center gap-1.5">
                <ChevronRight
                  class="size-3 text-muted-foreground transition-transform group-open:rotate-90"
                />
                <span class="font-mono text-muted-foreground">{section.id}</span>
                <span>{section.title}</span>
              </span>
              <span class="text-[10px] text-muted-foreground">
                {section.entries.filter((e) => e.status === 'resolved').length}/{section.entries.length}
              </span>
            </summary>
            <ul class="space-y-0.5 px-2 pb-2">
              {#each section.entries as entry (entry.id)}
                <li class="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-muted/40">
                  <button
                    type="button"
                    class={[
                      'mt-0.5 inline-flex shrink-0 items-center rounded border px-1 font-mono text-[10px]',
                      STATUS_CLASS[entry.status]
                    ]}
                    title={`Click to cycle status (current: ${entry.status})`}
                    aria-label={`Cycle status for branch ${entry.id}`}
                    onclick={() => onToggleBranch(entry.id, STATUS_CYCLE[entry.status])}
                  >
                    {STATUS_LABEL[entry.status]}
                  </button>
                  <span class="min-w-0 flex-1 text-[11px] leading-tight">
                    <span class="font-mono text-muted-foreground">{entry.id}</span>
                    <span class="ml-1">{entry.label || 'unlabeled'}</span>
                  </span>
                </li>
              {/each}
            </ul>
          </details>
        {/each}
      </div>
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
