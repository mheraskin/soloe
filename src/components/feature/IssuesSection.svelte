<script lang="ts">
  import { ChevronRight, CircleAlert, CircleCheck, ExternalLink, FileText } from '@lucide/svelte';
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
  let openCount = $derived(issueRows.length - solvedCount);
  let visibleIssues = $derived(
    hideSolved ? issueRows.filter((issue) => !isSolved(issue.status)) : issueRows
  );

  function statusKind(status: string | null): 'solved' | 'in_progress' | 'blocked' | 'open' {
    if (!status) return 'open';
    const lowered = status.toLowerCase();
    if (
      lowered.includes('solved') ||
      lowered.includes('resolved') ||
      lowered.includes('done') ||
      lowered.includes('closed')
    )
      return 'solved';
    if (lowered.includes('progress') || lowered.includes('doing') || lowered.includes('wip'))
      return 'in_progress';
    if (lowered.includes('blocked') || lowered.includes('waiting')) return 'blocked';
    return 'open';
  }

  const STATUS_PILL_CLASS = {
    solved: 'text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10',
    in_progress: 'text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10',
    blocked: 'text-rose-600 dark:text-rose-400 border-rose-500/40 bg-rose-500/10',
    open: 'text-muted-foreground border-border bg-background'
  } as const;

  function statusLabel(status: string | null): string {
    const kind = statusKind(status);
    if (kind === 'solved') return 'done';
    if (kind === 'in_progress') return 'wip';
    if (kind === 'blocked') return 'blocked';
    return status?.trim() || 'open';
  }

  function isSolved(status: string | null): boolean {
    return statusKind(status) === 'solved';
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
        <CircleAlert class={['size-3 shrink-0', openCount > 0 ? 'text-amber-500' : 'text-muted-foreground']} />
        <span class="font-medium text-foreground">Issues</span>
        {#if tracker.provider === 'github'}
          <span class="text-[10px] text-amber-500">(GitHub — coming soon)</span>
        {/if}
      </span>
      <span class="flex shrink-0 items-baseline gap-1 font-mono text-[10px] tabular-nums text-muted-foreground">
        <span class="text-foreground">{openCount}</span>
        {#if solvedCount > 0}
          <span class="opacity-50">·</span>
          <span class="text-emerald-500">{solvedCount} done</span>
        {/if}
      </span>
    </Collapsible.Trigger>
    {#if tracker.provider !== 'github' && issueRows.length > 0}
      <label class="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <Checkbox
          checked={hideSolved}
          onCheckedChange={(v) => featuresStore.setHideSolvedIssues(cwd, v === true)}
        />
        Hide done
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
          {@const kind = statusKind(issue.status)}
          {@const solved = kind === 'solved'}
          <li class="group/issue flex items-center gap-2 px-2.5 py-1.5 hover:bg-muted/40">
            <span class="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {issue.number ? `#${issue.number}` : '#?'}
            </span>
            <span
              class={[
                'inline-flex w-14 shrink-0 justify-center rounded border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider',
                STATUS_PILL_CLASS[kind]
              ]}
              title={issue.status ?? 'no status'}
            >
              {statusLabel(issue.status)}
            </span>
            <button
              type="button"
              class={[
                'min-w-0 flex-1 truncate text-left text-[11px] leading-tight hover:text-foreground',
                solved ? 'text-muted-foreground line-through' : 'text-foreground'
              ]}
              onclick={() => onOpenFile(issue.relativePath)}
              title={issue.title}
            >
              {issue.title}
            </button>
            <span class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/issue:opacity-100">
              {#if !solved}
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
            </span>
          </li>
        {/each}
        {#if visibleIssues.length === 0 && issueRows.length > 0}
          <li class="flex items-center gap-1.5 px-3 py-3 text-[11px] text-emerald-600 dark:text-emerald-400">
            <CircleCheck class="size-3" />
            All issues are done.
          </li>
        {/if}
        {#if artifactRows.length > 0}
          {#each artifactRows as artifact (artifact.relativePath)}
            <li class="group/artifact flex items-center gap-2 bg-muted/10 px-2.5 py-1.5 hover:bg-muted/40">
              <FileText class="size-3 shrink-0 text-muted-foreground" />
              <button
                type="button"
                class="flex min-w-0 flex-1 flex-col items-start text-left"
                onclick={() => onOpenFile(artifact.relativePath)}
                title={artifact.relativePath}
              >
                <span class="truncate font-mono text-[11px] text-foreground" title={artifact.displayName}>
                  {artifact.displayName}
                </span>
                {#if artifact.title}
                  <span class="truncate text-[10px] text-muted-foreground" title={artifact.title}>
                    {artifact.title}
                  </span>
                {/if}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open artifact in editor"
                title="Open in editor"
                class="shrink-0 opacity-0 transition-opacity group-hover/artifact:opacity-100"
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
