import { describe, expect, it } from 'vitest';
import source from './TerminalArea.svelte?raw';

describe('TerminalArea mobile layout', () => {
  it('owns a definite viewport even through a display-contents wrapper', () => {
    const rootClass = source.match(/<section class="([^"]*terminal-area[^"]*)">/)?.[1] ?? '';

    expect(rootClass).toMatch(/\bh-full\b/);
    expect(rootClass).toMatch(/\bmin-h-0\b/);
    expect(rootClass).toMatch(/\bw-full\b/);
  });
});
