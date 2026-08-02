<script lang="ts">
  import FixtureButton from './FixtureButton.svelte';

  let { title = 'Nested fixture card' }: { title?: string } = $props();
  let clicks = $state(0);
</script>

<article class="rounded-lg border border-border bg-card p-4 shadow-sm">
  <h2 class="mb-3 text-base font-medium">{title}</h2>
  <FixtureButton label={`Clicked ${clicks} times`} onClick={() => clicks += 1} />
</article>
