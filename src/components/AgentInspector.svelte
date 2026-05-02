<script lang="ts">
  import type { AgentObservedState } from '@shared/types/sessions.js';
  import type { ObservedAgentSnapshot } from '@shared/types/agents.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { Separator } from '$lib/components/ui/separator';

  let selected = $derived(sessions.selected);
  let observation = $derived(selected ? sessions.observationFor(selected.id) : null);
  let workers = $derived(selected ? sessions.childWorkersFor(selected.id) : []);

  function stateLabel(state: AgentObservedState | undefined): string {
    if (!state) return 'unobserved';
    return state.replaceAll('_', ' ');
  }

  function providerLabel(worker: ObservedAgentSnapshot): string {
    return worker.provider === 'claude_code' ? 'Claude' : 'Codex';
  }

  function stateClass(state: AgentObservedState | undefined): string {
    if (state === 'starting' || state === 'working' || state === 'running_tool') return 'text-amber-500';
    if (state === 'idle' || state === 'completed') return 'text-emerald-500';
    if (state === 'failed') return 'text-destructive';
    return 'text-muted-foreground';
  }

  async function stopWorker(workerId: string | undefined) {
    if (!workerId) return;
    try {
      await sessions.stopWorker(workerId);
    } catch (err) {
      reportError(err);
    }
  }
</script>

<aside class="flex w-[320px] flex-shrink-0 flex-col overflow-hidden border-l border-border bg-sidebar" aria-label="Agent inspector">
  <ScrollArea class="flex-1">
    <section class="flex flex-col gap-2 p-3">
      <div class="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Session</div>
      {#if selected}
        <div class="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2 text-xs">
          <span class="text-muted-foreground">State</span>
          <strong class={`font-medium ${stateClass(observation?.state)}`}>{stateLabel(observation?.state)}</strong>
        </div>
        <div class="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2 text-xs">
          <span class="text-muted-foreground">Runtime</span>
          <strong class="font-medium">{observation?.runtimeMode ?? 'tui'}</strong>
        </div>
        {#if observation?.providerThreadId}
          <div class="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2 text-xs">
            <span class="text-muted-foreground">Thread</span>
            <code class="font-mono text-[11px] break-all text-primary">{observation.providerThreadId}</code>
          </div>
        {/if}
        {#if observation?.lastEventAt}
          <div class="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2 text-xs">
            <span class="text-muted-foreground">Last event</span>
            <time datetime={observation.lastEventAt} class="text-muted-foreground">
              {new Date(observation.lastEventAt).toLocaleTimeString()}
            </time>
          </div>
        {/if}
      {:else}
        <p class="m-0 text-xs text-muted-foreground">No session selected</p>
      {/if}
    </section>

    <Separator />

    <section class="flex flex-col gap-2 p-3">
      <div class="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Workers</div>
      {#if workers.length === 0}
        <p class="m-0 text-xs text-muted-foreground">No background workers</p>
      {:else}
        <div class="flex flex-col gap-3">
          {#each workers as worker (worker.id)}
            <div class="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
              <div class="flex items-center justify-between gap-2">
                <div class="flex min-w-0 items-center gap-2">
                  <strong class="text-sm">{providerLabel(worker)}</strong>
                  <Badge variant="outline" class={`text-[10px] ${stateClass(worker.state)}`}>{stateLabel(worker.state)}</Badge>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={worker.state === 'completed' || worker.state === 'failed' || worker.state === 'exited'}
                  onclick={() => stopWorker(worker.workerId)}
                >
                  Stop
                </Button>
              </div>
              {#if worker.promptSummary}
                <p class="m-0 text-xs leading-snug break-words text-muted-foreground">{worker.promptSummary}</p>
              {/if}
              {#if worker.resultSummary}
                <p class="m-0 text-xs leading-snug break-words text-foreground">{worker.resultSummary}</p>
              {/if}
              {#if worker.providerThreadId}
                <code class="font-mono text-[11px] break-all text-primary">{worker.providerThreadId}</code>
              {/if}
              {#each sessions.eventsFor(worker.id).slice(0, 4) as event (event.id)}
                <div class="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-xs text-muted-foreground">
                  <time datetime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
                  <span class="break-words">{event.summary}</span>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </ScrollArea>
</aside>
