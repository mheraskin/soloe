import { describe, expect, it } from 'vitest';

import { terminalThemeFor } from './terminal-theme';

describe('terminal themes', () => {
  it('provides distinct, readable terminal surfaces', () => {
    expect(terminalThemeFor('light').background).toEqual({ r: 247, g: 248, b: 250 });
    expect(terminalThemeFor('dark').background).toEqual({ r: 15, g: 15, b: 16 });
  });

  it('preserves the xterm themes across the complete Ghostty palette', () => {
    const dark = terminalThemeFor('dark').palette;
    const light = terminalThemeFor('light').palette;

    expect(dark).toHaveLength(256);
    expect(light).toHaveLength(256);
    expect(dark?.[1]).toEqual({ r: 247, g: 118, b: 142 });
    expect(dark?.[12]).toEqual({ r: 141, g: 176, b: 255 });
    expect(light?.[1]).toEqual({ r: 207, g: 34, b: 46 });
    expect(dark?.[208]).toEqual({ r: 255, g: 135, b: 0 });
  });
});
