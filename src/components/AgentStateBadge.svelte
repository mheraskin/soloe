<script lang="ts">
  import type { AgentObservedState } from '@shared/types/sessions.js';
  import { agentStatePresentation } from '../lib/agent-state-presentation';
  import { cn } from '$lib/utils';

  let {
    state,
    summary = null,
    class: className = ''
  }: {
    state: AgentObservedState;
    summary?: string | null;
    class?: string;
  } = $props();

  const style = $derived(agentStatePresentation(state));
  // `running_tool` carries the tool name, which is more useful than the word
  // "tool" — it replaces the label rather than adding a second element.
  const detail = $derived(
    state === 'running_tool' && summary ? summary.replace(/^tool:\s*/i, '') : null
  );
  const text = $derived(detail ?? style.label);
  const tooltip = $derived(summary ? `${style.label} · ${summary}` : style.label);
  // Kept lowercase so assistive tech and tests read the canonical state name
  // while the visible label stays sentence case.
  const srLabel = $derived(tooltip.toLowerCase());
  const Icon = $derived(style.icon);
</script>

<span
  class={cn('sb-state', className)}
  data-tone={style.tone}
  data-chip={style.chip ? 'true' : 'false'}
  title={tooltip}
  aria-label={srLabel}
>
  {#if Icon}
    <Icon class={cn('size-2.5 shrink-0', style.spin && 'animate-spin')} />
  {/if}
  <span class="truncate">{text}</span>
</span>
