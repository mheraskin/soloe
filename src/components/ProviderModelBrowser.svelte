<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { Check, Search } from '@lucide/svelte';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { ModelCatalogEntry } from '@shared/types/settings.js';
  import {
    CLI_DEFAULT_MODEL_ID,
    modelCatalogProviderForRuntime
  } from '@shared/model-catalog.js';
  import { settings } from '../stores/settings.svelte';
  import { Input } from '$lib/components/ui/input';
  import { cn } from '$lib/utils';
  import KindIcon from './KindIcon.svelte';

  interface Props {
    provider: AgentRuntimeProvider;
    model?: string;
    providers?: readonly AgentRuntimeProvider[];
    providerLocked?: boolean;
    header?: Snippet;
    railFooter?: Snippet;
    footer?: Snippet;
    onselect: (provider: AgentRuntimeProvider, model: string | undefined) => void;
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
    header,
    railFooter,
    footer,
    onselect
  }: Props = $props();

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
      const entries = discovered.length === 0
        ? []
        : discovered.some((entry) => entry.isDefault)
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

  function selectModel(nextProvider: AgentRuntimeProvider, id: string): void {
    onselect(nextProvider, id === CLI_DEFAULT_MODEL_ID ? undefined : id);
    query = '';
  }

  onMount(() => {
    void settings.ensureModelCatalog();
  });
</script>

<div class="flex min-h-0 flex-1 overflow-hidden" data-slot="provider-model-browser">
  {#if (!providerLocked && selectableProviders.length > 1) || railFooter}
    <div class="relative flex w-14 shrink-0 overflow-hidden border-r border-border bg-foreground/[0.035]">
      <div
        class="flex min-h-0 w-full flex-col gap-1 overflow-y-auto px-1.5 pt-1.5 pb-7"
        data-slot="provider-rail"
      >
        {#if !providerLocked && selectableProviders.length > 1}
          {#each selectableProviders as candidate (candidate)}
            <button
              type="button"
              class={cn(
                'relative flex aspect-square w-full shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors',
                'hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                activeBrowseProvider === candidate && 'bg-background text-foreground shadow-sm'
              )}
              aria-label={`Browse ${providerLabels[candidate]} models`}
              aria-pressed={activeBrowseProvider === candidate}
              title={providerLabels[candidate]}
              data-launch-option={candidate}
              onclick={() => {
                browsedProvider = candidate;
                query = '';
              }}
            >
              {#if activeBrowseProvider === candidate}
                <span class="absolute top-1/2 right-0 h-5 w-0.5 -translate-y-1/2 rounded-l bg-primary"></span>
              {/if}
              <KindIcon kind={candidate} size={19} />
            </button>
          {/each}
        {/if}

        {#if railFooter}
          <div class="mt-1 flex flex-col gap-1 border-t border-border pt-1.5">
            {@render railFooter()}
          </div>
        {/if}
      </div>
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-popover via-popover/75 to-transparent"
        aria-hidden="true"
      ></div>
    </div>
  {/if}

  <div class="flex min-w-0 flex-1 flex-col bg-popover" data-slot="model-browser">
    {#if header}
      {@render header()}
    {/if}

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

    <div class="min-h-0 flex-1 overflow-y-auto p-1.5" data-slot="model-list">
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

    {#if footer}
      {@render footer()}
    {/if}
  </div>
</div>
