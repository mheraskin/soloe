<script lang="ts">
  import { Activity, AlertTriangle } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { rightRail, type RailTabId } from '../stores/right-rail.svelte';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import RailInspectorTab from './rail/RailInspectorTab.svelte';
  import RailDiagnosticsTab from './rail/RailDiagnosticsTab.svelte';

  interface Tab {
    id: RailTabId;
    label: string;
    icon: Component<any, {}, ''>;
  }

  const tabs: Tab[] = [
    { id: 'inspector', label: 'Inspector', icon: Activity },
    { id: 'diagnostics', label: 'Diagnostics', icon: AlertTriangle }
  ];
</script>

<aside
  class={rightRail.open
    ? 'flex w-[320px] flex-shrink-0 flex-row-reverse overflow-hidden border-l border-border bg-sidebar'
    : 'flex w-10 flex-shrink-0 flex-row-reverse overflow-hidden border-l border-border bg-sidebar'}
  aria-label="Session rail"
>
  <Tooltip.Provider delayDuration={250}>
    <nav class="flex w-10 flex-shrink-0 flex-col items-center gap-1 pt-2" aria-label="Rail tabs">
      {#each tabs as tab (tab.id)}
        {@const isActive = rightRail.open && rightRail.activeTab === tab.id}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={`flex size-8 items-center justify-center rounded-md transition-colors ${
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
                onclick={() => rightRail.toggleTab(tab.id)}
                aria-label={tab.label}
                aria-pressed={isActive}
              >
                <tab.icon class="size-4" />
              </button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="left">{tab.label}</Tooltip.Content>
        </Tooltip.Root>
      {/each}
    </nav>
  </Tooltip.Provider>

  {#if rightRail.open}
    <ScrollArea class="flex-1 border-r border-border">
      {#if rightRail.activeTab === 'inspector'}
        <RailInspectorTab />
      {:else if rightRail.activeTab === 'diagnostics'}
        <RailDiagnosticsTab />
      {/if}
    </ScrollArea>
  {/if}
</aside>
