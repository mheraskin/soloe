<script lang="ts">
  import { TerminalSquare } from '@lucide/svelte';
  import type { SessionKind } from '@shared/types/sessions.js';
  import claudeUrl from '../lib/icons/claude.svg';
  import codexUrl from '../lib/icons/codex.svg';

  let { kind, size = 14 }: { kind: SessionKind; size?: number } = $props();

  const sources: Partial<Record<SessionKind, { src: string; alt: string }>> = {
    claude_code: { src: claudeUrl, alt: 'Claude' },
    codex: { src: codexUrl, alt: 'Codex' }
  };

  let entry = $derived(sources[kind]);
</script>

{#if entry}
  <img class="icon" src={entry.src} alt={entry.alt} width={size} height={size} />
{:else if kind === 'standard_terminal'}
  <TerminalSquare class="icon" size={size} aria-label="Terminal" />
{/if}

<style>
  .icon {
    display: block;
    flex-shrink: 0;
    object-fit: contain;
  }
</style>
