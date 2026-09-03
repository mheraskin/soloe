<script lang="ts">
  import { ChevronDown } from '@lucide/svelte';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import { modelCatalogProviderForRuntime } from '@shared/model-catalog.js';
  import { settings } from '../stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Popover from '$lib/components/ui/popover';
  import { cn } from '$lib/utils';
  import KindIcon from './KindIcon.svelte';
  import ProviderModelBrowser from './ProviderModelBrowser.svelte';

  interface Props {
    provider: AgentRuntimeProvider;
    model?: string;
    providers?: readonly AgentRuntimeProvider[];
    providerLocked?: boolean;
    compact?: boolean;
    triggerClass?: string;
    ariaLabel?: string;
    onchange: (provider: AgentRuntimeProvider, model: string | undefined) => void;
  }

  const allProviders: readonly AgentRuntimeProvider[] = [
    'claude_code',
    'codex',
    'cursor',
    'opencode',
    'grok_build',
    'antigravity'
  ];

  const providerLabels: Record<AgentRuntimeProvider, string> = {
    claude_code: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    grok_build: 'Grok Build',
    antigravity: 'Antigravity'
  };

  let {
    provider,
    model = undefined,
    providers = allProviders,
    providerLocked = false,
    compact = false,
    triggerClass = '',
    ariaLabel = 'Provider and model',
    onchange
  }: Props = $props();

  let open = $state(false);
  let selectedEntry = $derived(
    model
      ? settings.availableModels.find(
          (entry) => entry.provider === modelCatalogProviderForRuntime(provider) && entry.id === model
        )
      : undefined
  );
  let selectedLabel = $derived(
    selectedEntry?.label ?? model ?? `${providerLabels[provider]} default`
  );

  function selectModel(nextProvider: AgentRuntimeProvider, nextModel: string | undefined): void {
    onchange(nextProvider, nextModel);
    open = false;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        size={compact ? 'xs' : 'default'}
        class={cn('min-w-0 justify-between', compact ? 'max-w-56' : 'w-full', triggerClass)}
        aria-label={ariaLabel}
      >
        <span class="flex min-w-0 items-center gap-2">
          <KindIcon kind={provider} size={compact ? 12 : 14} />
          <span class="truncate">{selectedLabel}</span>
        </span>
        <ChevronDown class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Button>
    {/snippet}
  </Popover.Trigger>

  <Popover.Content
    align="start"
    class="flex h-[min(23rem,calc(100vh-3rem))] w-[min(24rem,calc(100vw-2rem))] min-h-0 overflow-hidden p-0"
  >
    <ProviderModelBrowser
      {provider}
      {model}
      {providers}
      {providerLocked}
      onselect={selectModel}
    />
  </Popover.Content>
</Popover.Root>
