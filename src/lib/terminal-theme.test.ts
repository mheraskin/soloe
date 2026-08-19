import { describe, expect, it } from 'vitest';

import { terminalThemeFor } from './terminal-theme';

describe('terminal themes', () => {
  it('provides distinct, readable terminal surfaces', () => {
    expect(terminalThemeFor('light').background).toEqual({ r: 247, g: 248, b: 250 });
    expect(terminalThemeFor('dark').background).toEqual({ r: 15, g: 15, b: 16 });
  });
});
