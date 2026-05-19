<script lang="ts">
  import { ChevronRight, FileText } from '@lucide/svelte';
  import type { FeaturePlanEntry } from '@shared/types/features.js';
  import * as Collapsible from '$lib/components/ui/collapsible';

  interface Props {
    plans: FeaturePlanEntry[];
    onOpenFile: (relativePath: string) => void;
  }

  let { plans, onOpenFile }: Props = $props();
</script>

<Collapsible.Root open={plans.length > 0} class="rounded-md border border-border">
  <Collapsible.Trigger
    class="group flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs font-medium hover:bg-muted/40"
  >
    <span class="flex items-center gap-1.5">
      <ChevronRight
        class="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
      />
      <span class="font-medium text-foreground">Plans</span>
    </span>
    <span class="text-[10px] text-muted-foreground">{plans.length}</span>
  </Collapsible.Trigger>
  <Collapsible.Content class="border-t border-border">
    {#if plans.length === 0}
      <div class="px-3 py-3 text-[11px] text-muted-foreground">
        No plans matching this grilling session.
      </div>
    {:else}
      <ul class="divide-y divide-border">
        {#each plans as plan (plan.relativePath)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-muted/40"
              onclick={() => onOpenFile(plan.relativePath)}
              title={plan.relativePath}
            >
              <FileText class="size-3 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate font-mono">{plan.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </Collapsible.Content>
</Collapsible.Root>
