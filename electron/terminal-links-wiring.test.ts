import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractTerminalLinks } from '../src/lib/ghostty/links';

const terminalComponents = [
  'src/components/TerminalPane.svelte',
  'src/components/DeviceTerminalViewer.svelte'
];

describe('Ghostty terminal hyperlink wiring', () => {
  it('detects plain URLs and file paths without an xterm link addon', () => {
    expect(extractTerminalLinks('open https://example.test or src/main.ts:12')).toEqual([
      expect.objectContaining({ kind: 'url', text: 'https://example.test' }),
      expect.objectContaining({ kind: 'path', text: 'src/main.ts:12' })
    ]);
  });

  it.each(terminalComponents)('%s owns Ghostty link activation', (filePath) => {
    const source = readFileSync(filePath, 'utf8');
    expect(source).toContain('onLinkActivate={activateLink}');
  });
});
