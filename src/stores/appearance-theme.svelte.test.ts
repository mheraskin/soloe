import { describe, expect, it } from 'vitest';

import { resolveAppearanceTheme } from './appearance-theme.svelte';

describe('resolveAppearanceTheme', () => {
  it('keeps an explicit light or dark choice', () => {
    expect(resolveAppearanceTheme('light', true)).toBe('light');
    expect(resolveAppearanceTheme('dark', false)).toBe('dark');
  });

  it('follows the system color scheme in automatic mode', () => {
    expect(resolveAppearanceTheme('system', true)).toBe('dark');
    expect(resolveAppearanceTheme('system', false)).toBe('light');
  });
});
