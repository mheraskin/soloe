<script lang="ts">
  import { ChevronRight, FileText, GitBranch, CircleAlert, ExternalLink } from '@lucide/svelte';
  import type { FeatureSnapshot } from '@shared/types/features.js';

  interface Props {
    slug: string;
    snapshot: FeatureSnapshot;
    onOpenFile: (relativePath: string) => void;
  }

  let { slug, snapshot, onOpenFile }: Props = $props();

  let coverage = $derived(snapshot.coverage);
  let counts = $derived(coverage?.counts ?? { todo: 0, in_progress: 0, resolved: 0, deferred: 0 });
  let total = $derived(counts.todo + counts.in_progress + counts.resolved + counts.deferred);
  let done = $derived(counts.resolved + counts.deferred);
  let percent = $derived(total > 0 ? Math.round((done / total) * 100) : 0);

  let openIssues = $derived(
    snapshot.issues.filter((issue) => {
      if (issue.kind !== 'issue') return false;
      const s = issue.status?.toLowerCase() ?? '';
      return !(
        s.includes('solved') ||
        s.includes('resolved') ||
        s.includes('done') ||
        s.includes('closed')
      );
    }).length
  );
  let totalIssues = $derived(snapshot.issues.filter((i) => i.kind === 'issue').length);
  let planCount = $derived(snapshot.plans.length);

  let nextEntry = $derived(coverage?.currentlyGrilling ?? null);
  let allDone = $derived(coverage?.exists && total > 0 && counts.todo === 0 && counts.in_progress === 0);

  function openCoverage(): void {
    if (coverage?.relativePath) onOpenFile(coverage.relativePath);
  }
</script>

<section
  class="overflow-hidden rounded-md border border-border bg-card"
  aria-label={`Feature ${slug}`}
>
  <div class="flex items-baseline justify-between gap-2 px-3 pt-2.5">
    <span class="min-w-0 truncate font-mono text-sm font-medium text-foreground" title={slug}>
      {slug}
    </span>
    {#if coverage?.exists && total > 0}
      <span class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        <span class="text-foreground">{done}</span>/<span>{total}</span>
        <span class="ml-1 text-foreground">{percent}%</span>
      </span>
    {/if}
  </div>

  {#if coverage?.exists && total > 0}
    <div class="px-3 pb-2.5 pt-1.5">
      <div
        class="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Coverage progress"
      >
        <div
          class={[
            'h-full transition-[width] duration-300',
            allDone ? 'bg-emerald-500' : 'bg-emerald-500/80'
          ]}
          style="width: {percent}%"
        ></div>
      </div>
    </div>
  {:else}
    <div class="px-3 pb-2.5 pt-0.5 text-[11px] text-muted-foreground">
      {#if !coverage?.exists}
        No coverage map yet — run <span class="font-mono">/grill-with-docs</span> to start.
      {:else}
        Coverage map is empty.
      {/if}
    </div>
  {/if}

  {#if coverage?.exists && nextEntry}
    <button
      type="button"
      class="group flex w-full items-center gap-1.5 border-t border-border bg-muted/20 px-3 py-2 text-left text-[11px] hover:bg-muted/40"
      onclick={openCoverage}
      title="Open coverage map"
    >
      <ChevronRight class="size-3 shrink-0 text-amber-500" />
      <span class="shrink-0 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        Next
      </span>
      <span class="shrink-0 font-mono text-muted-foreground">{nextEntry.entry.id}</span>
      <span class="min-w-0 flex-1 truncate text-foreground" title={nextEntry.entry.label}>
        {nextEntry.entry.label || 'unlabeled branch'}
      </span>
      <ExternalLink
        class="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  {:else if coverage?.exists && allDone}
    <div class="flex items-center gap-1.5 border-t border-border bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-600 dark:text-emerald-400">
      <span class="font-medium">All branches resolved.</span>
    </div>
  {/if}

  <div class="mobile-feature-stats grid grid-cols-3 gap-px border-t border-border bg-border/60">
    <div class="flex flex-col items-center justify-center gap-0.5 bg-card px-2 py-2">
      <span class="inline-flex items-center gap-1 text-sm font-semibold tabular-nums text-foreground">
        <GitBranch class="size-3 text-muted-foreground" />
        {total}
      </span>
      <span class="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        branches
      </span>
    </div>
    <div class="flex flex-col items-center justify-center gap-0.5 bg-card px-2 py-2">
      <span class="inline-flex items-center gap-1 text-sm font-semibold tabular-nums text-foreground">
        <FileText class="size-3 text-muted-foreground" />
        {planCount}
      </span>
      <span class="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        plans
      </span>
    </div>
    <div class="flex flex-col items-center justify-center gap-0.5 bg-card px-2 py-2">
      <span class="inline-flex items-center gap-1 text-sm font-semibold tabular-nums text-foreground">
        <CircleAlert class={['size-3', openIssues > 0 ? 'text-amber-500' : 'text-muted-foreground']} />
        {openIssues}{#if totalIssues > openIssues}<span class="text-muted-foreground">/{totalIssues}</span>{/if}
      </span>
      <span class="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        open
      </span>
    </div>
  </div>
</section>
