<script lang="ts">
  import { ChevronRight, ExternalLink, FlaskConical } from '@lucide/svelte';
  import type { FeatureIssueEntry, IssueTrackerConfig } from '@shared/types/features.js';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import { Button } from '$lib/components/ui/button';

  interface Props {
    issues: FeatureIssueEntry[];
    tracker: IssueTrackerConfig;
    onOpenFile: (relativePath: string) => void;
  }

  let { issues, tracker, onOpenFile }: Props = $props();

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
</script>

<Collapsible.Root open={true} class="rounded-md border border-border">
  <Collapsible.Trigger
    class="group flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs font-medium hover:bg-muted/40"
  >
    <span class="flex items-center gap-1.5">
      <ChevronRight
        class="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
      />
      <span class="font-medium text-foreground">Issues</span>
      {#if tracker.provider === 'github'}
        <span class="text-[10px] text-amber-500">(GitHub — coming soon)</span>
      {/if}
    </span>
    <span class="text-[10px] text-muted-foreground">{issues.length}</span>
  </Collapsible.Trigger>
  <Collapsible.Content class="border-t border-border">
    {#if tracker.provider === 'github'}
      <div class="px-3 py-3 text-[11px] text-muted-foreground">
        GitHub issues integration is coming soon. For now, track issues as local markdown
        in <span class="font-mono">.scratch/&lt;slug&gt;/issues/</span>.
      </div>
    {:else if issues.length === 0}
      <div class="px-3 py-3 text-[11px] text-muted-foreground">
        No issues yet. Use <span class="font-mono">/to-issues</span> from a plan to publish them.
      </div>
    {:else}
      <ul class="divide-y divide-border">
        {#each issues as issue (issue.relativePath)}
          <li class="flex items-center gap-2 px-2.5 py-1.5 hover:bg-muted/40">
            <span
              class={[
                'inline-flex shrink-0 items-center rounded border px-1 font-mono text-[10px]',
                statusClass(issue.status)
              ]}
              title={issue.status ?? 'no status'}
            >
              {issue.status ?? '—'}
            </span>
            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              {#if issue.isPlaywright}
                <FlaskConical class="size-3 shrink-0 text-purple-400" />
              {/if}
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-[11px] text-foreground" title={issue.title}>
                  {issue.title}
                </span>
                <span class="truncate font-mono text-[10px] text-muted-foreground" title={issue.relativePath}>
                  {issue.name}
                </span>
              </div>
            </div>
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
      </ul>
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
