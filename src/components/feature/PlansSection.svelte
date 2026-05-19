<script lang="ts">
  import { ChevronRight, FileText, ExternalLink } from '@lucide/svelte';
  import type { FeaturePlanEntry } from '@shared/types/features.js';
  import { featuresStore } from '../../stores/features.svelte';
  import * as Collapsible from '$lib/components/ui/collapsible';
  import { Button } from '$lib/components/ui/button';

  interface Props {
    cwd: string;
    plans: FeaturePlanEntry[];
    onOpenFile: (relativePath: string) => void;
  }

  let { cwd, plans, onOpenFile }: Props = $props();
  let open = $derived(featuresStore.sectionOpenFor(cwd, 'plans', plans.length > 0));

  function onOpenChange(nextOpen: boolean): void {
    featuresStore.setSectionOpen(cwd, 'plans', nextOpen);
  }
</script>

<Collapsible.Root {open} onOpenChange={onOpenChange} class="rounded-md border border-border">
  <Collapsible.Trigger
    class="group flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs font-medium hover:bg-muted/40"
  >
    <span class="flex min-w-0 items-center gap-1.5">
      <ChevronRight
        class="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
      />
      <FileText class="size-3 shrink-0 text-muted-foreground" />
      <span class="font-medium text-foreground">Plans</span>
    </span>
    <span class="font-mono text-[10px] tabular-nums text-muted-foreground">{plans.length}</span>
  </Collapsible.Trigger>
  <Collapsible.Content class="border-t border-border">
    {#if plans.length === 0}
      <div class="px-3 py-3 text-[11px] text-muted-foreground">
        No plans for this feature. Run <span class="font-mono">/plan-with-grilling</span> from a session.
      </div>
    {:else}
      <ul class="divide-y divide-border">
        {#each plans as plan (plan.relativePath)}
          <li class="group/plan flex items-center gap-2 px-2.5 py-1.5 hover:bg-muted/40">
            <FileText class="size-3 shrink-0 text-muted-foreground" />
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-foreground hover:text-foreground"
              onclick={() => onOpenFile(plan.relativePath)}
              title={plan.relativePath}
            >
              {plan.name}
            </button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open plan in editor"
              title="Open in editor"
              class="shrink-0 opacity-0 transition-opacity group-hover/plan:opacity-100"
              onclick={() => onOpenFile(plan.relativePath)}
            >
              <ExternalLink class="size-3" />
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
