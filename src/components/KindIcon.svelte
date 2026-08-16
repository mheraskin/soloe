<script lang="ts">
  import { MousePointer2, TerminalSquare } from '@lucide/svelte';
  import type { SessionLaunchKind } from '@shared/types/sessions.js';
  import claudeUrl from '../lib/icons/claude.svg';
  import codexUrl from '../lib/icons/codex.svg';

  let { kind, size = 14 }: { kind: SessionLaunchKind; size?: number } = $props();

  const sources: Partial<Record<SessionLaunchKind, { src: string; alt: string }>> = {
    claude_code: { src: claudeUrl, alt: 'Claude' },
    codex: { src: codexUrl, alt: 'Codex' }
  };

  let entry = $derived(sources[kind]);
</script>

{#if entry}
  <img class="icon" src={entry.src} alt={entry.alt} width={size} height={size} />
{:else if kind === 'terminal'}
  <TerminalSquare class="icon" size={size} aria-label="Terminal" />
{:else if kind === 'cursor'}
  <MousePointer2 class="icon" size={size} aria-label="Cursor" />
{/if}

<style>
  .icon {
    display: block;
    flex-shrink: 0;
    object-fit: contain;
  }
</style>
