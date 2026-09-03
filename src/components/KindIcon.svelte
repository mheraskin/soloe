<script lang="ts">
  import { TerminalSquare } from '@lucide/svelte';
  import type { SessionLaunchKind } from '@shared/types/sessions.js';
  import antigravityDarkUrl from '../lib/icons/antigravity-dark.svg';
  import antigravityLightUrl from '../lib/icons/antigravity-light.svg';
  import claudeUrl from '../lib/icons/claude.svg';
  import codexLightUrl from '../lib/icons/codex-light.svg';
  import codexUrl from '../lib/icons/codex.svg';
  import cursorLightUrl from '../lib/icons/cursor-light.svg';
  import cursorUrl from '../lib/icons/cursor.svg';
  import grokDarkUrl from '../lib/icons/grok-dark.svg';
  import grokLightUrl from '../lib/icons/grok-light.svg';
  import opencodeDarkUrl from '../lib/icons/opencode-dark.svg';
  import opencodeLightUrl from '../lib/icons/opencode-light.svg';

  let { kind, size = 14 }: { kind: SessionLaunchKind; size?: number } = $props();

  const sources: Partial<
    Record<SessionLaunchKind, { lightSrc: string; darkSrc?: string; alt: string }>
  > = {
    antigravity: {
      lightSrc: antigravityLightUrl,
      darkSrc: antigravityDarkUrl,
      alt: 'Antigravity'
    },
    claude_code: { lightSrc: claudeUrl, alt: 'Claude' },
    codex: { lightSrc: codexLightUrl, darkSrc: codexUrl, alt: 'Codex' },
    cursor: { lightSrc: cursorLightUrl, darkSrc: cursorUrl, alt: 'Cursor' },
    grok_build: { lightSrc: grokLightUrl, darkSrc: grokDarkUrl, alt: 'Grok Build' },
    opencode: {
      lightSrc: opencodeLightUrl,
      darkSrc: opencodeDarkUrl,
      alt: 'OpenCode'
    }
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
