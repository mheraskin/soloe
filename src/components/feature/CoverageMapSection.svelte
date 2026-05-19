<script lang="ts">
  import { ChevronRight, ExternalLink, Map } from '@lucide/svelte';
  import type { BranchStatus, CoverageMapSnapshot } from '@shared/types/features.js';
  import { featuresStore } from '../../stores/features.svelte';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import { Button } from '$lib/components/ui/button';

  interface Props {
    cwd: string;
    coverage: CoverageMapSnapshot;
    onToggleBranch: (branchId: string, next: BranchStatus) => void;
    onOpenFile: (relativePath: string) => void;
  }

  let { cwd, coverage, onToggleBranch, onOpenFile }: Props = $props();
  let open = $derived(featuresStore.sectionOpenFor(cwd, 'coverage', true));

  function onOpenChange(nextOpen: boolean): void {
    featuresStore.setSectionOpen(cwd, 'coverage', nextOpen);
  }

  let total = $derived(
    coverage.counts.todo +
      coverage.counts.in_progress +
      coverage.counts.resolved +
      coverage.counts.deferred
  );
  let percent = $derived(
    total > 0
      ? Math.round(((coverage.counts.resolved + coverage.counts.deferred) / total) * 100)
      : 0
  );

  const STATUS_CYCLE: Record<BranchStatus, BranchStatus> = {
    todo: 'in_progress',
    in_progress: 'resolved',
    resolved: 'deferred',
    deferred: 'todo'
  };

  const STATUS_GLYPH: Record<BranchStatus, string> = {
    todo: '[ ]',
    in_progress: '[~]',
    resolved: '[x]',
    deferred: '[D]'
  };

  const STATUS_DESCRIPTION: Record<BranchStatus, string> = {
    todo: 'todo',
    in_progress: 'in progress',
    resolved: 'resolved',
    deferred: 'deferred'
  };

  const STATUS_CLASS: Record<BranchStatus, string> = {
    todo: 'text-muted-foreground/80 border-border bg-background',
    in_progress: 'text-amber-500 border-amber-500/40 bg-amber-500/5',
    resolved: 'text-emerald-500 border-emerald-500/40 bg-emerald-500/5',
    deferred: 'text-slate-400 border-slate-400/40 bg-slate-400/5'
  };
</script>

<Collapsible.Root {open} onOpenChange={onOpenChange} class="rounded-md border border-border">
  <Collapsible.Trigger
    class="group flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs font-medium hover:bg-muted/40"
  >
    <span class="flex min-w-0 items-center gap-1.5">
      <ChevronRight
        class="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
      />
      <Map class="size-3 shrink-0 text-muted-foreground" />
      <span class="font-medium text-foreground">Coverage map</span>
      {#if !coverage.exists}
        <span class="text-[10px] text-muted-foreground">— not started</span>
      {/if}
    </span>
    {#if coverage.exists && total > 0}
      <span class="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        <span class="text-foreground">{percent}%</span>
        <span class="opacity-50">·</span>
        <span>{coverage.counts.resolved + coverage.counts.deferred}/{total}</span>
      </span>
    {/if}
  </Collapsible.Trigger>
  <Collapsible.Content class="border-t border-border">
    {#if !coverage.exists}
      <div class="px-3 py-3 text-[11px] text-muted-foreground">
        No coverage map at <span class="font-mono">{coverage.relativePath}</span>. Run
        <span class="font-mono">/grill-with-docs</span> in a session to seed it.
      </div>
    {:else if coverage.error}
      <div class="px-3 py-3 text-[11px] text-destructive">
        Failed to read coverage map: {coverage.error}
      </div>
    {:else}
      <div class="flex items-center justify-between gap-2 border-b border-border bg-muted/20 px-2.5 py-1.5">
        <div class="flex min-w-0 flex-1 items-center gap-2 text-[10px]">
          <span
            class={[
              'inline-flex items-center gap-1 rounded border px-1 py-0.5 font-mono',
              STATUS_CLASS.resolved
            ]}
            title="Resolved"
          >
            <span aria-hidden="true">[x]</span>
            <span class="tabular-nums">{coverage.counts.resolved}</span>
          </span>
          <span
            class={[
              'inline-flex items-center gap-1 rounded border px-1 py-0.5 font-mono',
              STATUS_CLASS.in_progress
            ]}
            title="In progress"
          >
            <span aria-hidden="true">[~]</span>
            <span class="tabular-nums">{coverage.counts.in_progress}</span>
          </span>
          <span
            class={[
              'inline-flex items-center gap-1 rounded border px-1 py-0.5 font-mono',
              STATUS_CLASS.todo
            ]}
            title="Todo"
          >
            <span aria-hidden="true">[ ]</span>
            <span class="tabular-nums">{coverage.counts.todo}</span>
          </span>
          {#if coverage.counts.deferred > 0}
            <span
              class={[
                'inline-flex items-center gap-1 rounded border px-1 py-0.5 font-mono',
                STATUS_CLASS.deferred
              ]}
              title="Deferred"
            >
              <span aria-hidden="true">[D]</span>
              <span class="tabular-nums">{coverage.counts.deferred}</span>
            </span>
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
          {@const resolvedInSection = section.entries.filter((e) => e.status === 'resolved' || e.status === 'deferred').length}
          {@const sectionPercent = section.entries.length > 0 ? Math.round((resolvedInSection / section.entries.length) * 100) : 0}
          <details class="group" open>
            <summary
              class="flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted/40"
            >
              <span class="flex min-w-0 items-center gap-1.5">
                <ChevronRight
                  class="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                />
                <span class="font-mono text-muted-foreground">{section.id}</span>
                <span class="min-w-0 truncate">{section.title}</span>
              </span>
              <span class="flex shrink-0 items-center gap-1.5">
                <span
                  class="h-1 w-8 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <span
                    class="block h-full bg-emerald-500/70"
                    style="width: {sectionPercent}%"
                  ></span>
                </span>
                <span class="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {resolvedInSection}/{section.entries.length}
                </span>
              </span>
            </summary>
            <ul class="space-y-0.5 px-2 pb-2">
              {#each section.entries as entry, entryIndex (`${section.id}:${entry.lineIndex}:${entry.id}:${entryIndex}`)}
                {@const isCurrent = entry.status === 'in_progress'}
                <li
                  class={[
                    'flex items-start gap-2 rounded px-1.5 py-1 hover:bg-muted/40',
                    isCurrent && 'bg-amber-500/5'
                  ]}
                >
                  <button
                    type="button"
                    class={[
                      'mt-0.5 inline-flex shrink-0 items-center rounded border px-1 font-mono text-[10px]',
                      STATUS_CLASS[entry.status]
                    ]}
                    title={`${STATUS_DESCRIPTION[entry.status]} — click to mark ${STATUS_DESCRIPTION[STATUS_CYCLE[entry.status]]}`}
                    aria-label={`Cycle status for branch ${entry.id}`}
                    onclick={() => onToggleBranch(entry.id, STATUS_CYCLE[entry.status])}
                  >
                    {STATUS_GLYPH[entry.status]}
                  </button>
                  <span class="min-w-0 flex-1 text-[11px] leading-tight">
                    <span class="font-mono text-muted-foreground">{entry.id}</span>
                    <span class={['ml-1', entry.status === 'resolved' && 'text-muted-foreground line-through']}>
                      {entry.label || 'unlabeled'}
                    </span>
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
