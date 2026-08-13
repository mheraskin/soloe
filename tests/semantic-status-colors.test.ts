import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('semantic status colors', () => {
  it.each(['success', 'warning'])('defines the %s color used by status indicators', async (name) => {
    const css = await readFile(new URL('../src/app.css', import.meta.url), 'utf8');

    expect(css).toContain(`--${name}:`);
    expect(css).toContain(`--color-${name}: var(--${name});`);
  });
});
