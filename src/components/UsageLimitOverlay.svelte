<script lang="ts">
  import { Gauge, Loader2 } from '@lucide/svelte';
  import type { AgentRuntimeProvider, Session } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { displaySessionKind } from '../lib/session-agent';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import KindIcon from './KindIcon.svelte';

  let { session }: { session: Session } = $props();

  let busyProvider = $state<AgentRuntimeProvider | null>(null);

  let observed = $derived(sessions.observationFor(session.id));
  let usageLimit = $derived(sessions.usageLimitFor(session.id));
  let currentKind = $derived(displaySessionKind(session, observed));
  let resetLabel = $derived(usageLimit?.resetAtLabel ?? null);

  async function continueWith(provider: AgentRuntimeProvider): Promise<void> {
    if (busyProvider) return;
    busyProvider = provider;
    try {
      await sessions.continueWithAgent(session.id, provider);
    } catch (err) {
      reportError(err);
    } finally {
      busyProvider = null;
    }
  }

  function optionClass(provider: AgentRuntimeProvider): string {
    return cn(
      'h-20 flex-col gap-1.5 border border-border bg-background/75 px-3 text-xs shadow-sm backdrop-blur',
      busyProvider === provider && 'opacity-80'
    );
  }
</script>

<div class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/35 p-6 backdrop-blur-[1px]">
  <div class="pointer-events-auto w-[min(460px,100%)] rounded-md border border-border bg-popover/95 p-4 text-popover-foreground shadow-xl">
    <div class="mb-3 flex items-center gap-2">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-md border border-warning/40 bg-warning/10 text-warning">
        <Gauge class="size-4" />
      </span>
      <span class="grid min-w-0 gap-0.5">
        <span class="text-sm leading-5 font-semibold">Usage limit reached</span>
        <span class="truncate text-xs leading-4 text-muted-foreground">
          {resetLabel ? `Resets ${resetLabel}` : usageLimit?.message ?? session.name}
        </span>
      </span>
    </div>

    <div class="grid grid-cols-3 gap-2">
      <div class="flex h-20 flex-col items-center justify-center gap-1.5 rounded-md border border-warning/45 bg-warning/10 px-3 text-xs text-warning">
        <KindIcon kind={currentKind} size={24} />
        <span class="max-w-full truncate font-medium">Limited</span>
      </div>
      <Button
        variant="ghost"
        class={optionClass('claude_code')}
        onclick={() => void continueWith('claude_code')}
        disabled={busyProvider !== null}
      >
        {#if busyProvider === 'claude_code'}
          <Loader2 class="size-6 animate-spin" />
        {:else}
          <KindIcon kind="claude_code" size={24} />
        {/if}
        <span class="leading-none">Claude</span>
      </Button>
      <Button
        variant="ghost"
        class={optionClass('codex')}
        onclick={() => void continueWith('codex')}
        disabled={busyProvider !== null}
      >
        {#if busyProvider === 'codex'}
          <Loader2 class="size-6 animate-spin" />
        {:else}
          <KindIcon kind="codex" size={24} />
        {/if}
        <span class="leading-none">Codex</span>
      </Button>
    </div>
  </div>
</div>
