<script lang="ts">
  import type { Component } from 'svelte';
  import { LazyModule, type ModuleLoader } from '../lib/lazy-module.svelte';
  import { reportError } from '../stores/toast.svelte';

  type OverlayModule = { default: Component };

  interface Props {
    label: string;
    load: ModuleLoader<OverlayModule>;
  }

  let { label, load }: Props = $props();
  const module = new LazyModule(() => load());
  let reportedError: Error | null = null;

  $effect(() => {
    void module.load();
  });

  $effect(() => {
    const error = module.error;
    if (!error || error === reportedError) return;
    reportedError = error;
    reportError(new Error(`Could not load ${label}: ${error.message}`, { cause: error }));
  });
</script>

{#if module.value}
  {@const LoadedOverlay = module.value.default}
  <LoadedOverlay />
{:else}
  <span class="sr-only" role="status">Loading {label}…</span>
{/if}
