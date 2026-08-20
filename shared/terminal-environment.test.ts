import { describe, expect, it } from 'vitest';
import { mergeTerminalEnvironment } from './terminal-environment.js';

describe('mergeTerminalEnvironment', () => {
  it('removes NO_COLOR case-insensitively while preserving terminal capabilities', () => {
    expect(mergeTerminalEnvironment(
      { PATH: '/usr/bin', NO_COLOR: '1', no_color: 'true' },
      { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    )).toEqual({
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    });
  });
});
