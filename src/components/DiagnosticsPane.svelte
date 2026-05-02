<script lang="ts">
  import { Activity, AlertTriangle, Settings } from '@lucide/svelte';
  import type { CrashLogSummary, DiagnosticItem } from '@shared/types/diagnostics.js';
  import { diagnosticsPane } from '../stores/diagnostics-pane.svelte';
  import { settings } from '../stores/settings.svelte';
  import { ipc } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Sheet from '$lib/components/ui/sheet';
  import * as Alert from '$lib/components/ui/alert';

  let items = $state<DiagnosticItem[]>([]);
  let crashes = $state<CrashLogSummary[]>([]);
  let loading = $state(false);

  $effect(() => {
    if (!diagnosticsPane.open) return;
    loading = true;
    Promise.all([ipc.diagnostics.list(), ipc.diagnostics.crashLogs()])
      .then(([nextItems, nextCrashes]) => {
        items = nextItems;
        crashes = nextCrashes;
      })
      .catch(reportError)
      .finally(() => {
        loading = false;
      });
  });

  function runAction(item: DiagnosticItem): void {
    if (item.action === 'settings') {
      diagnosticsPane.close();
      settings.openDrawer();
    }
  }

  function onOpenChange(next: boolean) {
    if (!next) diagnosticsPane.close();
  }
</script>

<Sheet.Root open={diagnosticsPane.open} {onOpenChange}>
  <Sheet.Content side="right" class="w-[420px] max-w-full gap-0 p-0">
    <Sheet.Header class="border-b border-border">
      <Sheet.Title class="text-base font-medium">Diagnostics</Sheet.Title>
      <Sheet.Description class="text-xs text-muted-foreground">
        {items.length} issue{items.length === 1 ? '' : 's'}
      </Sheet.Description>
    </Sheet.Header>

    <ScrollArea class="flex-1">
      <div class="flex flex-col gap-2 p-3">
        {#if loading}
          <p class="m-0 text-xs text-muted-foreground">Checking…</p>
        {:else if items.length === 0}
          <p class="m-0 text-xs text-muted-foreground">No issues</p>
        {:else}
          {#each items as item (item.id)}
            <Alert.Root variant={item.severity === 'error' ? 'destructive' : 'default'}>
              {#if item.severity === 'info'}
                <Activity />
              {:else}
                <AlertTriangle class={item.severity === 'warn' ? 'text-amber-500' : ''} />
              {/if}
              <Alert.Title>{item.message}</Alert.Title>
              {#if item.detail}
                <Alert.Description>{item.detail}</Alert.Description>
              {/if}
              {#if item.action === 'settings'}
                <div class="absolute top-2 right-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onclick={() => runAction(item)}
                    title="Open settings"
                    aria-label="Open settings"
                  >
                    <Settings />
                  </Button>
                </div>
              {/if}
            </Alert.Root>
          {/each}
        {/if}

        {#if crashes.length > 0}
          <h3 class="mt-3 mb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Crash logs
          </h3>
          {#each crashes as crash (crash.path)}
            <div class="flex items-center justify-between gap-3 rounded-md bg-muted px-2.5 py-1.5 font-mono text-[11px]">
              <span class="truncate">{crash.fileName}</span>
              <time class="shrink-0 text-muted-foreground">{new Date(crash.createdAt).toLocaleString()}</time>
            </div>
          {/each}
        {/if}
      </div>
    </ScrollArea>
  </Sheet.Content>
</Sheet.Root>
