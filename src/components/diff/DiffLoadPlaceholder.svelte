<script lang="ts">
  import { AlertCircle, Loader2, RefreshCw } from '@lucide/svelte';

  let {
    loading,
    error,
    onLoad
  }: {
    loading: boolean;
    error: string | null;
    onLoad: () => void;
  } = $props();
</script>

{#if loading}
  <div class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
    <Loader2 class="size-3 animate-spin" />
    Loading diff…
  </div>
{:else if error}
  <div class="flex flex-col items-center justify-center gap-2 px-3 py-4 text-xs text-destructive">
    <div class="flex items-start gap-2">
      <AlertCircle class="size-3 shrink-0" />
      <span class="break-words">{error}</span>
    </div>
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded border border-destructive/40 px-2 py-1 text-[11px] transition-colors hover:bg-destructive/10"
      onclick={onLoad}
    >
      <RefreshCw class="size-3" />
      Retry
    </button>
  </div>
{:else}
  <div class="flex flex-col items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
    <span>Diff not loaded.</span>
    <button
      type="button"
      class="rounded border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted"
      onclick={onLoad}
    >
      Load diff
    </button>
  </div>
{/if}
