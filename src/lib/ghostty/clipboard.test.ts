import { describe, expect, it } from 'vitest';

import { TerminalClipboardSequenceParser } from './clipboard';

describe('TerminalClipboardSequenceParser', () => {
  it('decodes OSC 52 clipboard writes terminated by BEL or ST', () => {
    const parser = new TerminalClipboardSequenceParser();

    expect(parser.push(`before\u001b]52;c;${base64('first')}\u0007after`)).toEqual(['first']);
    expect(parser.push(`\u001b]52;p;${base64('second')}\u001b\\`)).toEqual(['second']);
  });

  it('reassembles a clipboard sequence split across output chunks', () => {
    const parser = new TerminalClipboardSequenceParser();
    const encoded = base64('copied on the controlling device');

    expect(parser.push(`\u001b]52;c;${encoded.slice(0, 8)}`)).toEqual([]);
    expect(parser.push(`${encoded.slice(8)}\u001b`)).toEqual([]);
    expect(parser.push('\\')).toEqual(['copied on the controlling device']);
  });

  it('decodes OSC 52 nested in tmux passthrough output', () => {
    const parser = new TerminalClipboardSequenceParser();
    const encoded = base64('copied from Claude in tmux');

    expect(parser.push(
      `\u001bPtmux;\u001b\u001b]52;c;${encoded}\u001b\u001b\\\u001b\\`,
    )).toEqual(['copied from Claude in tmux']);
  });

  it('ignores clipboard reads and malformed payloads', () => {
    const parser = new TerminalClipboardSequenceParser();

    expect(parser.push('\u001b]52;c;?\u0007')).toEqual([]);
    expect(parser.push('\u001b]52;c;not-base64!\u0007')).toEqual([]);
  });
});

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(String.fromCharCode(...bytes));
}
