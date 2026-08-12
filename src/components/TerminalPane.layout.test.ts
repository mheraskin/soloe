import { describe, expect, it } from 'vitest';
import source from './TerminalPane.svelte?raw';

describe('TerminalPane layout', () => {
  it('lets xterm use the complete pane without an outer inset', () => {
    const shellClass = source.match(/class="terminal-pane-shell ([^"]+)"/)?.[1] ?? '';

    expect(shellClass).not.toMatch(/\bp-(?:0\.5|1|2|3|4|5|6|7|8)\b/);
    expect(source).not.toMatch(/:global\(\.xterm\)\s*\{[^}]*\bpadding:/s);
  });

  it('does not reserve a hidden scrollbar gutter at the right edge', () => {
    expect(source).toMatch(
      /data-overlay-scrollbars='macos'[^\{]*:global\(\.xterm-viewport\)\s*\{[^}]*scrollbar-width:\s*none/s
    );
    expect(source).toMatch(
      /data-overlay-scrollbars='macos'[^\{]*:global\(\.xterm-viewport::-webkit-scrollbar\)\s*\{[^}]*width:\s*0/s
    );
  });
});
