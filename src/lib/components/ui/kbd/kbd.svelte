<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils';

  let {
    keys,
    class: className = '',
    ...rest
  }: HTMLAttributes<HTMLSpanElement> & { keys: string[] } = $props();
</script>

<span
  class={cn(
    'inline-flex items-center gap-0.5 font-mono text-[10px] leading-none tracking-tight',
    className
  )}
  {...rest}
>
  {#each keys as k, i (i)}
    <kbd
      class="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 text-foreground"
    >
      {k}
    </kbd>
  {/each}
</span>
