<script lang="ts">
  import { Braces, Sparkles, TerminalSquare } from '@lucide/svelte';
  import type { SessionLaunchKind } from '@shared/types/sessions.js';
  import claudeUrl from '../lib/icons/claude.svg';
  import codexLightUrl from '../lib/icons/codex-light.svg';
  import codexUrl from '../lib/icons/codex.svg';
  import cursorLightUrl from '../lib/icons/cursor-light.svg';
  import cursorUrl from '../lib/icons/cursor.svg';

  let { kind, size = 14 }: { kind: SessionLaunchKind; size?: number } = $props();

  const sources: Partial<
    Record<SessionLaunchKind, { lightSrc: string; darkSrc?: string; alt: string }>
  > = {
    claude_code: { lightSrc: claudeUrl, alt: 'Claude' },
    codex: { lightSrc: codexLightUrl, darkSrc: codexUrl, alt: 'Codex' },
    cursor: { lightSrc: cursorLightUrl, darkSrc: cursorUrl, alt: 'Cursor' }
  };

  let entry = $derived(sources[kind]);
</script>

{#if entry}
  <img
    class:theme-light={entry.darkSrc}
    class="icon"
    src={entry.lightSrc}
    alt={entry.alt}
    width={size}
    height={size}
  />
  {#if entry.darkSrc}
    <img
      class="icon theme-dark"
      src={entry.darkSrc}
      alt={entry.alt}
      width={size}
      height={size}
    />
  {/if}
{:else if kind === 'terminal'}
  <TerminalSquare class="icon" size={size} aria-label="Terminal" />
{:else if kind === 'opencode'}
  <Braces class="icon" size={size} aria-label="OpenCode" />
{:else if kind === 'grok_build'}
  <Sparkles class="icon" size={size} aria-label="Grok Build" />
{/if}

<style>
  .icon {
    display: block;
    flex-shrink: 0;
    object-fit: contain;
  }

  .theme-dark {
    display: none;
  }

  :global(.dark) .theme-light {
    display: none;
  }

  :global(.dark) .theme-dark {
    display: block;
  }
</style>
