<script lang="ts">
  import { ChevronDown, Map, FileText, CircleAlert, Search, X } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import type { FeatureSlug } from '@shared/types/features.js';

  interface Props {
    features: FeatureSlug[];
    value: string | null;
    onSelect: (slug: string | null) => void;
  }

  let { features, value, onSelect }: Props = $props();

  let open = $state(false);
  let query = $state('');
  let inputEl: HTMLInputElement | null = $state(null);
  let rootEl: HTMLDivElement | null = $state(null);
  let highlightIndex = $state(0);

  let filtered = $derived.by<FeatureSlug[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return features;
    return features.filter((f) => f.slug.toLowerCase().includes(q));
  });

  let currentFeature = $derived(value ? features.find((f) => f.slug === value) ?? null : null);

  $effect(() => {
    if (highlightIndex >= filtered.length) {
      highlightIndex = Math.max(0, filtered.length - 1);
    }
  });

  function close(): void {
    open = false;
    query = '';
    highlightIndex = 0;
  }

  async function toggle(): Promise<void> {
    open = !open;
    if (open) {
      await tick();
      inputEl?.focus();
      if (value) {
        const idx = filtered.findIndex((f) => f.slug === value);
        if (idx >= 0) highlightIndex = idx;
      }
    }
  }

  function pick(slug: string): void {
    onSelect(slug);
    close();
  }

  function clear(): void {
    onSelect(null);
    close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlightIndex = Math.min(filtered.length - 1, highlightIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightIndex = Math.max(0, highlightIndex - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const pick0 = filtered[highlightIndex];
      if (pick0) pick(pick0.slug);
      return;
    }
  }

  function onDocumentClick(event: MouseEvent): void {
    if (!open || !rootEl) return;
    const target = event.target as Node | null;
    if (target && rootEl.contains(target)) return;
    close();
  }

  onMount(() => {
    window.addEventListener('mousedown', onDocumentClick);
    return () => window.removeEventListener('mousedown', onDocumentClick);
  });
</script>

<div bind:this={rootEl} class="relative flex w-full items-center gap-1">
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center justify-between gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-left text-xs font-medium text-foreground hover:bg-muted/60"
    onclick={toggle}
    aria-haspopup="listbox"
    aria-expanded={open}
    data-feature-picker-trigger
  >
    <span class="flex min-w-0 flex-1 items-center gap-1.5">
      {#if currentFeature}
        <span class="min-w-0 flex-1 truncate font-mono">{currentFeature.slug}</span>
        <span class="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          {#if currentFeature.hasCoverage}
            <Map class="size-3" />
          {/if}
          {#if currentFeature.hasPlans}
            <FileText class="size-3" />
          {/if}
          {#if currentFeature.hasIssues}
            <CircleAlert class="size-3" />
          {/if}
        </span>
      {:else}
        <span class="text-muted-foreground">Select a feature…</span>
      {/if}
    </span>
    <ChevronDown
      class={['size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180']}
    />
  </button>
  {#if value}
    <button
      type="button"
      aria-label="Clear feature selection"
      title="Clear selection"
      class="shrink-0 rounded border border-border bg-background p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      onclick={clear}
    >
      <X class="size-3" />
    </button>
  {/if}

  {#if open}
    <div
      class="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      <div class="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Search class="size-3 text-muted-foreground" />
        <input
          bind:this={inputEl}
          bind:value={query}
          type="text"
          placeholder="Filter features…"
          class="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          onkeydown={onKeydown}
          spellcheck="false"
          autocomplete="off"
        />
        {#if query}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground"
            aria-label="Clear filter"
            onclick={() => {
              query = '';
              inputEl?.focus();
            }}
          >
            <X class="size-3" />
          </button>
        {/if}
      </div>
      <ul
        class="max-h-72 overflow-y-auto py-1"
        role="listbox"
        aria-label="Features"
      >
        {#if filtered.length === 0}
          <li class="px-3 py-3 text-center text-[11px] text-muted-foreground">
            {#if features.length === 0}
              No features yet. Run <span class="font-mono">/grill-with-docs</span> in a session.
            {:else}
              No features match "{query}".
            {/if}
          </li>
        {/if}
        {#each filtered as feature, i (feature.slug)}
          {@const isSelected = feature.slug === value}
          {@const isHighlighted = i === highlightIndex}
          <li>
            <button
              type="button"
              class={[
                'flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs',
                isHighlighted ? 'bg-muted text-foreground' : 'text-foreground/90 hover:bg-muted/60'
              ]}
              role="option"
              aria-selected={isSelected}
              onmouseenter={() => (highlightIndex = i)}
              onclick={() => pick(feature.slug)}
            >
              <span class="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  class={[
                    'size-1.5 shrink-0 rounded-full',
                    isSelected ? 'bg-emerald-500' : 'bg-transparent'
                  ]}
                  aria-hidden="true"
                ></span>
                <span class="min-w-0 flex-1 truncate font-mono">{feature.slug}</span>
              </span>
              <span class="flex shrink-0 items-center gap-1 text-muted-foreground">
                <span class={['inline-flex items-center', !feature.hasCoverage && 'opacity-25']}
                  title={feature.hasCoverage ? 'Coverage map' : 'No coverage map'}>
                  <Map class="size-3" />
                </span>
                <span class={['inline-flex items-center', !feature.hasPlans && 'opacity-25']}
                  title={feature.hasPlans ? 'Has plan' : 'No plan'}>
                  <FileText class="size-3" />
                </span>
                <span class={['inline-flex items-center', !feature.hasIssues && 'opacity-25']}
                  title={feature.hasIssues ? 'Has issues' : 'No issues'}>
                  <CircleAlert class="size-3" />
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
