<script lang="ts">
  import { kbdHints } from '../stores/kbd-hints.svelte';
  import { Kbd } from '$lib/components/ui/kbd';

  let {
    keys,
    class: className = ''
  }: { keys: string[]; class?: string } = $props();
</script>

{#if kbdHints.altHeld}
  <Kbd {keys} class={className} aria-hidden="true" />
{/if}
