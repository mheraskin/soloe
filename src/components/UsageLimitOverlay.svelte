<script lang="ts">
  import { Gauge, Loader2, X } from '@lucide/svelte';
  import type { AgentRuntimeProvider, Session } from '@shared/types/sessions.js';
  import { launchProvider } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { displaySessionKind } from '../lib/session-agent';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import KindIcon from './KindIcon.svelte';

  let {
    session,
    onClose
  }: {
    session: Session;
    onClose?: () => void;
  } = $props();

  let busyProvider = $state<AgentRuntimeProvider | null>(null);
  const providers: AgentRuntimeProvider[] = ['claude_code', 'codex'];

  let observed = $derived(sessions.observationFor(session.id));
  let usageLimit = $derived(sessions.usageLimitFor(session.id));
  let currentKind = $derived(displaySessionKind(session, observed));
  let currentProvider = $derived(agentProviderFor(session, observed?.provider));
  let resetLabel = $derived(usageLimit?.resetAtLabel ?? null);
  let isUsageLimited = $derived(observed?.state === 'usage_limited');
  let title = $derived(
    isUsageLimited
      ? `${providerName(currentProvider)} usage limit reached`
      : `${providerName(currentProvider)} stopped`
  );
  let detail = $derived(overlayDetail(resetLabel, usageLimit?.message, currentProvider));
  let currentLabel = $derived(isUsageLimited ? 'Limited' : 'Stopped');
  let providerOptions = $derived(
    currentProvider
      ? providers.filter((provider) => provider !== currentProvider)
      : providers.filter((provider) => provider !== currentKind)
  );

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

  function providerLabel(provider: AgentRuntimeProvider): string {
    return provider === 'claude_code' ? 'Claude' : 'Codex';
  }

  function providerName(provider: AgentRuntimeProvider | null): string {
    return provider ? providerLabel(provider) : 'Agent';
  }

  function agentProviderFor(
    value: Session,
    observedProvider: string | undefined
  ): AgentRuntimeProvider | null {
    if (observedProvider === 'claude_code' || observedProvider === 'codex') return observedProvider;
    return value.currentAgentRuntime?.provider ?? launchProvider(value);
  }

  function overlayDetail(
    reset: string | null,
    message: string | undefined,
    provider: AgentRuntimeProvider | null
  ): string {
    if (reset) return `Resets ${reset}`;
    if (message && isUsefulLimitMessage(message)) return message;
    const label = provider ? providerLabel(provider) : 'Agent';
    return `${label} cannot continue this tab right now. Choose another agent to carry the context forward.`;
  }

  function isUsefulLimitMessage(message: string): boolean {
    const trimmed = message.trim();
    if (!trimmed) return false;
    if (/^[a-f0-9-]{16,}$/i.test(trimmed)) return false;
    if (trimmed.length < 12 && !/limit|reset|try again/i.test(trimmed)) return false;
    return true;
  }
</script>

<button
  type="button"
  class="mobile-usage-overlay absolute inset-0 z-20 flex cursor-default items-center justify-center bg-background/35 p-6 text-left backdrop-blur-[1px]"
  onclick={onClose}
  aria-label="Dismiss handoff overlay"
>
  <div
    class="relative w-[min(380px,100%)] rounded-md border border-border bg-popover/95 p-4 text-popover-foreground shadow-xl"
    role="presentation"
    onclick={(event) => event.stopPropagation()}
  >
    {#if onClose}
      <Button
        variant="ghost"
        size="icon-sm"
        class="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
        onclick={onClose}
        title="Dismiss handoff"
        aria-label="Dismiss handoff"
      >
        <X />
      </Button>
    {/if}
    <div class="mb-3 flex items-center gap-2 pr-7">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-md border border-warning/40 bg-warning/10 text-warning">
        <Gauge class="size-4" />
      </span>
      <span class="grid min-w-0 gap-0.5">
        <span class="text-sm leading-5 font-semibold">{title}</span>
        <span class="truncate text-xs leading-4 text-muted-foreground">
          {detail}
        </span>
      </span>
    </div>

    <div class="mobile-provider-grid grid grid-cols-2 gap-2">
      <div class="flex h-20 flex-col items-center justify-center gap-1.5 rounded-md border border-warning/45 bg-warning/10 px-3 text-xs text-warning">
        <KindIcon kind={currentKind} size={24} />
        <span class="max-w-full truncate font-medium">{currentLabel}</span>
      </div>
      {#each providerOptions as provider (provider)}
        <Button
          variant="ghost"
          class={optionClass(provider)}
          onclick={() => void continueWith(provider)}
          disabled={busyProvider !== null}
        >
          {#if busyProvider === provider}
            <Loader2 class="size-6 animate-spin" />
          {:else}
            <KindIcon kind={provider} size={24} />
          {/if}
          <span class="leading-none">{providerLabel(provider)}</span>
        </Button>
      {/each}
    </div>
  </div>
</button>
