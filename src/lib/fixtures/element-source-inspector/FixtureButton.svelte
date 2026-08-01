<script lang="ts">
  let { label = 'Inspect me', onClick }: { label?: string; onClick?: () => void } = $props();
</script>

<button
  type="button"
  class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
  onclick={onClick}
>
  {label}
</button>
