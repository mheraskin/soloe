<script lang="ts">
  import { ChevronRight, CircleCheck, ExternalLink, FileText } from '@lucide/svelte';
  import type { FeatureIssueEntry, IssueTrackerConfig } from '@shared/types/features.js';
  import { featuresStore } from '../../stores/features.svelte';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';

  interface Props {
    cwd: string;
    issues: FeatureIssueEntry[];
    tracker: IssueTrackerConfig;
    onOpenFile: (relativePath: string) => void;
    onSetStatus: (relativePath: string, status: string) => Promise<void>;
  }

  let { cwd, issues, tracker, onOpenFile, onSetStatus }: Props = $props();

  let open = $derived(featuresStore.sectionOpenFor(cwd, 'issues', true));
  let updatingByPath = $state<Record<string, boolean>>({});

  function onOpenChange(nextOpen: boolean): void {
    featuresStore.setSectionOpen(cwd, 'issues', nextOpen);
  }

  let hideSolved = $derived(featuresStore.hideSolvedIssuesFor(cwd));
  let issueRows = $derived(issues.filter((issue) => issue.kind === 'issue'));
  let artifactRows = $derived(issues.filter((issue) => issue.kind !== 'issue'));
  let solvedCount = $derived(issueRows.filter((issue) => isSolved(issue.status)).length);
  let visibleIssues = $derived(
    hideSolved ? issueRows.filter((issue) => !isSolved(issue.status)) : issueRows
  );

  function statusClass(status: string | null): string {
    if (!status) return 'text-muted-foreground/70 border-border';
    const lowered = status.toLowerCase();
    if (lowered.includes('solved') || lowered.includes('done') || lowered.includes('closed')) {
      return 'text-emerald-500 border-emerald-500/40';
    }
    if (lowered.includes('progress') || lowered.includes('doing') || lowered.includes('wip')) {
      return 'text-amber-500 border-amber-500/40';
    }
    if (lowered.includes('blocked') || lowered.includes('waiting')) {
      return 'text-rose-500 border-rose-500/40';
    }
    return 'text-muted-foreground border-border';
  }

  function statusLabel(status: string | null): string {
    return status?.trim() || 'unset';
  }

  function isSolved(status: string | null): boolean {
    if (!status) return false;
    const lowered = status.toLowerCase();
    return (
      lowered.includes('solved') ||
      lowered.includes('resolved') ||
      lowered.includes('done') ||
      lowered.includes('closed')
    );
  }

  async function markSolved(issue: FeatureIssueEntry): Promise<void> {
    updatingByPath = { ...updatingByPath, [issue.relativePath]: true };
    try {
      await onSetStatus(issue.relativePath, 'solved');
    } finally {
      const next = { ...updatingByPath };
      delete next[issue.relativePath];
      updatingByPath = next;
    }
  }
</script>

<Collapsible.Root {open} onOpenChange={onOpenChange} class="rounded-md border border-border">
  <div class="flex items-center gap-2 px-2.5 py-2 hover:bg-muted/40">
    <Collapsible.Trigger
      class="group flex min-w-0 flex-1 items-center justify-between gap-2 text-left text-xs font-medium"
    >
      <span class="flex min-w-0 items-center gap-1.5">
        <ChevronRight
          class="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
        />
        <span class="font-medium text-foreground">Issues</span>
        {#if tracker.provider === 'github'}
          <span class="text-[10px] text-amber-500">(GitHub — coming soon)</span>
        {/if}
      </span>
      <span class="flex shrink-0 items-baseline gap-1.5">
        <span class="text-base font-semibold leading-none text-foreground">{visibleIssues.length}</span>
        <span class="text-[10px] text-muted-foreground">/ {issueRows.length}</span>
        {#if solvedCount > 0}
          <span class="text-[10px] text-emerald-500">{solvedCount} solved</span>
        {/if}
      </span>
    </Collapsible.Trigger>
    {#if tracker.provider !== 'github' && issueRows.length > 0}
      <label class="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <Checkbox
          checked={hideSolved}
          onCheckedChange={(v) => featuresStore.setHideSolvedIssues(cwd, v === true)}
        />
        Hide solved
      </label>
    {/if}
  </div>
  <Collapsible.Content class="border-t border-border">
    {#if tracker.provider === 'github'}
      <div class="px-3 py-3 text-[11px] text-muted-foreground">
        GitHub issues integration is coming soon. For now, track issues as local markdown
        in <span class="font-mono">.scratch/&lt;slug&gt;/issues/</span>.
      </div>
    {:else if issueRows.length === 0 && artifactRows.length === 0}
      <div class="px-3 py-3 text-[11px] text-muted-foreground">
        No issues yet. Use <span class="font-mono">/to-issues</span> from a plan to publish them.
      </div>
    {:else}
      <ul class="divide-y divide-border">
        {#each visibleIssues as issue (issue.relativePath)}
          <li class="flex items-center gap-2 px-2.5 py-2 hover:bg-muted/40">
            <span class="w-10 shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground">
              {issue.number ? `#${issue.number}` : '#?'}
            </span>
            <span
              class={[
                'inline-flex w-16 shrink-0 justify-center rounded border px-1 py-0.5 text-[10px] font-medium',
                statusClass(issue.status)
              ]}
              title={issue.status ?? 'no status'}
            >
              {statusLabel(issue.status)}
            </span>
            <span class="min-w-0 flex-1 truncate text-[11px] text-foreground" title={issue.title}>
              {issue.title}
            </span>
            {#if !isSolved(issue.status)}
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={updatingByPath[issue.relativePath] === true}
                onclick={() => void markSolved(issue)}
                aria-label="Mark issue as solved"
                title="Mark as solved"
              >
                <CircleCheck class="size-3" />
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open issue in editor"
              title="Open in editor"
              onclick={() => onOpenFile(issue.relativePath)}
            >
              <ExternalLink class="size-3" />
            </Button>
          </li>
        {/each}
        {#if visibleIssues.length === 0 && issueRows.length > 0}
          <li class="px-3 py-3 text-[11px] text-muted-foreground">
            All issues are solved.
          </li>
        {/if}
        {#if artifactRows.length > 0}
          {#each artifactRows as artifact (artifact.relativePath)}
            <li class="flex items-center gap-2 bg-muted/10 px-2.5 py-2 hover:bg-muted/40">
              <FileText class="size-3.5 shrink-0 text-muted-foreground" />
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate font-mono text-[11px] text-foreground" title={artifact.displayName}>
                  {artifact.displayName}
                </span>
                <span class="truncate text-[10px] text-muted-foreground" title={artifact.title}>
                  {artifact.title}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open artifact in editor"
                title="Open in editor"
                onclick={() => onOpenFile(artifact.relativePath)}
              >
                <ExternalLink class="size-3" />
              </Button>
            </li>
          {/each}
        {/if}
      </ul>
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
