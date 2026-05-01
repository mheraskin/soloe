<script lang="ts">
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
  <svg
    class="icon"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-label="Terminal"
    role="img"
  >
    <polyline points="5 8 9 12 5 16" />
    <line x1="12" y1="16" x2="18" y2="16" />
  </svg>
{/if}

<style>
  .icon {
    display: block;
    flex-shrink: 0;
    object-fit: contain;
  }
</style>
