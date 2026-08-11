<script lang="ts">
  import FixtureCard from './FixtureCard.svelte';

  let ready = $state(true);
</script>

<main class="min-h-screen bg-background p-8 text-foreground">
  <div class="mx-auto max-w-md space-y-4">
    <header>
      <p class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Inspector fixture</p>
      <h1 class="text-2xl font-semibold">Nested Svelte source targets</h1>
    </header>
    <FixtureCard title={ready ? 'Ready card' : 'Paused card'} />
    <button type="button" class="text-sm underline" onclick={() => ready = !ready}>
      Toggle card state
    </button>
  </div>
</main>
