import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { terminalLinkHandlers } from '../src/lib/terminal-links';

const terminalComponents = [
  'src/components/TerminalPane.svelte',
  'src/components/DeviceTerminalViewer.svelte'
];

describe('terminal hyperlink wiring', () => {
  it('routes OSC 8 and plain-text links through the same opener', () => {
    const opened: string[] = [];
    const handlers = terminalLinkHandlers((uri) => opened.push(uri));
    const event = {} as MouseEvent;

    handlers.osc.activate(event, 'http://localhost:8877', {
      start: { x: 1, y: 1 },
      end: { x: 10, y: 1 }
    });
    handlers.web(event, 'https://example.test');

    expect(opened).toEqual(['http://localhost:8877', 'https://example.test']);
    expect(handlers.osc.allowNonHttpProtocols).not.toBe(true);
  });

  it.each(terminalComponents)('%s overrides xterm OSC 8 navigation', (filePath) => {
    const source = readFileSync(filePath, 'utf8');

    expect(source).toContain('linkHandler: terminalLinks.osc');
  });
});
