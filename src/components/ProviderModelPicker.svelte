<script lang="ts">
  import { Check, ChevronDown, Search } from '@lucide/svelte';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { ModelCatalogEntry } from '@shared/types/settings.js';
  import {
    CLI_DEFAULT_MODEL_ID,
    modelCatalogProviderForRuntime
  } from '@shared/model-catalog.js';
  import { settings } from '../stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Popover from '$lib/components/ui/popover';
  import { cn } from '$lib/utils';
  import KindIcon from './KindIcon.svelte';

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
    'grok_build'
  ];

  const providerLabels: Record<AgentRuntimeProvider, string> = {
    claude_code: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    grok_build: 'Grok Build'
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
  let query = $state('');
  let browsedProvider = $state<AgentRuntimeProvider | null>(null);

  let selectableProviders = $derived(
    providerLocked ? [provider] : [...new Set(providers)]
  );
  let activeBrowseProvider = $derived(
    selectableProviders.includes(browsedProvider ?? provider)
      ? (browsedProvider ?? provider)
      : (selectableProviders[0] ?? provider)
  );

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

  let visibleModels = $derived.by(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const candidates: Array<ModelCatalogEntry & { runtimeProvider: AgentRuntimeProvider }> = [];
    const providersToSearch = normalizedQuery && !providerLocked
      ? selectableProviders
      : [activeBrowseProvider];
    for (const runtimeProvider of providersToSearch) {
      const catalogProvider = modelCatalogProviderForRuntime(runtimeProvider);
      const discovered = settings.availableModels.filter(
        (entry) => entry.provider === catalogProvider
      );
      const entries = discovered.some((entry) => entry.isDefault)
        ? discovered
        : [{
            provider: catalogProvider,
            id: CLI_DEFAULT_MODEL_ID,
            label: `${providerLabels[runtimeProvider]} default`,
            isDefault: true
          }, ...discovered];
      for (const entry of entries) {
        const searchable = `${entry.label} ${entry.id} ${providerLabels[runtimeProvider]}`.toLowerCase();
        if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
        candidates.push({ ...entry, runtimeProvider });
      }
    }
    return candidates;
  });

  let customModel = $derived.by(() => {
    const value = query.trim();
    if (!value || value === CLI_DEFAULT_MODEL_ID) return null;
    const exact = settings.availableModels.some((entry) =>
      entry.provider === modelCatalogProviderForRuntime(activeBrowseProvider)
      && entry.id.toLowerCase() === value.toLowerCase()
    );
    return exact ? null : value;
  });

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) {
      browsedProvider = provider;
      void settings.ensureModelCatalog();
      return;
    }
    query = '';
  }

  function selectModel(nextProvider: AgentRuntimeProvider, id: string): void {
    onchange(nextProvider, id === CLI_DEFAULT_MODEL_ID ? undefined : id);
    open = false;
    query = '';
  }
</script>

<Popover.Root {open} onOpenChange={handleOpenChange}>
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
    {#if !providerLocked && selectableProviders.length > 1 && !query.trim()}
      <div class="flex w-12 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-muted/30 p-1">
        {#each selectableProviders as candidate (candidate)}
          <button
            type="button"
            class={cn(
              'relative flex aspect-square w-full items-center justify-center rounded-md text-muted-foreground outline-none transition-colors',
              'hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
              activeBrowseProvider === candidate && 'bg-background text-foreground shadow-sm'
            )}
            aria-label={providerLabels[candidate]}
            aria-pressed={activeBrowseProvider === candidate}
            title={providerLabels[candidate]}
            onclick={() => {
              browsedProvider = candidate;
              query = '';
            }}
          >
            {#if activeBrowseProvider === candidate}
              <span class="absolute top-1/2 right-0 h-5 w-0.5 -translate-y-1/2 rounded-l bg-primary"></span>
            {/if}
            <KindIcon kind={candidate} size={18} />
          </button>
        {/each}
      </div>
    {/if}

    <div class="flex min-w-0 flex-1 flex-col bg-popover">
      <div class="border-b border-border p-2">
        <div class="relative">
          <Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            bind:value={query}
            class="h-8 pl-7 text-xs"
            placeholder="Search models or enter an ID…"
            aria-label="Search models"
          />
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        {#if visibleModels.length === 0 && !customModel}
          <div class="px-3 py-8 text-center text-xs text-muted-foreground">No models found</div>
        {:else}
          {#each visibleModels as entry (`${entry.provider}:${entry.id}`)}
            {@const isSelected = entry.runtimeProvider === provider
              && (entry.isDefault ? !model : entry.id === model)}
            <button
              type="button"
              class={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors',
                'hover:bg-muted focus-visible:bg-muted',
                isSelected && 'bg-muted'
              )}
              onclick={() => selectModel(entry.runtimeProvider, entry.id)}
            >
              <KindIcon kind={entry.runtimeProvider} size={15} />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium">{entry.label}</span>
                {#if !entry.isDefault}
                  <span class="block truncate font-mono text-[10px] text-muted-foreground">{entry.id}</span>
                {/if}
              </span>
              {#if query.trim() && !providerLocked}
                <span class="text-[9px] text-muted-foreground">{providerLabels[entry.runtimeProvider]}</span>
              {/if}
              {#if isSelected}
                <Check class="size-3.5 shrink-0 text-primary" aria-label="Selected" />
              {/if}
            </button>
          {/each}

          {#if customModel}
            <button
              type="button"
              class="mt-1 flex w-full items-center gap-2 border-t border-border px-2 py-2 text-left outline-none hover:bg-muted focus-visible:bg-muted"
              onclick={() => selectModel(activeBrowseProvider, customModel!)}
            >
              <KindIcon kind={activeBrowseProvider} size={15} />
              <span class="min-w-0 flex-1">
                <span class="block text-xs font-medium">Use custom model</span>
                <span class="block truncate font-mono text-[10px] text-muted-foreground">{customModel}</span>
              </span>
            </button>
          {/if}
        {/if}
      </div>
    </div>
  </Popover.Content>
</Popover.Root>
