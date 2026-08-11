<script lang="ts">
  import type { Component } from 'svelte';
  import { AlertCircle, Loader2, RefreshCw } from '@lucide/svelte';
  import { LazyModule, type ModuleLoader } from '../../lib/lazy-module.svelte';
  import { Button } from '$lib/components/ui/button';

  type RailContentModule = { default: Component };

  interface Props {
    label: string;
    load: ModuleLoader<RailContentModule>;
  }

  let { label, load }: Props = $props();
  const module = new LazyModule(() => load());

  $effect(() => {
    void module.load();
  });
</script>

{#if module.value}
  {@const LoadedContent = module.value.default}
  <LoadedContent />
{:else if module.error}
  <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
    <AlertCircle class="size-5 text-destructive" />
    <div class="space-y-1">
      <p class="text-sm font-medium">Could not load {label}</p>
      <p class="max-w-80 text-xs text-muted-foreground">{module.error.message}</p>
    </div>
    <Button variant="outline" size="sm" onclick={() => void module.load()}>
      <RefreshCw class="size-3.5" />
      Retry
    </Button>
  </div>
{:else}
  <div
    class="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
    aria-busy="true"
    aria-label={`Loading ${label}`}
  >
    <Loader2 class="size-4 animate-spin" />
    Loading {label}…
  </div>
{/if}
