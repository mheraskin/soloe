<script lang="ts">
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import KindIcon from '../KindIcon.svelte';

  interface Props {
    name: string;
    provider: AgentRuntimeProvider;
    model?: string | undefined;
    title?: string | undefined;
  }

  let { name, provider, model, title }: Props = $props();
</script>

<span
  class="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
  title={title ?? `${name}${model ? ` · ${model}` : ''}`}
>
  <KindIcon kind={provider} size={10} />
  <span class="text-foreground">{name}</span>
</span>
