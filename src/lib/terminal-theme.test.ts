import { describe, expect, it } from 'vitest';

import { terminalThemeFor, terminalTranscriptColor } from './terminal-theme';

describe('terminal themes', () => {
  it('provides distinct, readable terminal surfaces', () => {
    expect(terminalThemeFor('light').background).toBe('#f7f8fa');
    expect(terminalThemeFor('dark').background).toBe('#0f0f10');
  });

  it('remaps indexed transcript colors through the active palette', () => {
    expect(terminalTranscriptColor('#e5e5e5', 'light')).toBe('#6e7781');
    expect(terminalTranscriptColor('#e5e5e5', 'dark')).toBe('#a9b1d6');
    expect(terminalTranscriptColor('#123456', 'light')).toBe('#123456');
  });
});
