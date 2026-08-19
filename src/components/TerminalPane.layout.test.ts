import { describe, expect, it } from 'vitest';
import source from './TerminalPane.svelte?raw';
import deviceViewerSource from './DeviceTerminalViewer.svelte?raw';

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

  it('does not renew or release durable Session Control with pane visibility', () => {
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('terminalControl.release(terminalId)');
  });

  it('mounts xterm before waiting for a screen snapshot over the network', () => {
    const initializeAt = source.indexOf('const t = new Terminal({');
    const openAt = source.indexOf('t.open(host)', initializeAt);
    const snapshotAt = source.indexOf('() => ipc.terminal.screenSnapshot(terminalId)', initializeAt);

    expect(initializeAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThan(initializeAt);
    expect(snapshotAt).toBeGreaterThan(initializeAt);
    expect(openAt).toBeLessThan(snapshotAt);
  });

  it('mounts remote xterm before waiting for its device snapshot', () => {
    const initializeAt = deviceViewerSource.indexOf('const terminal = new Terminal({');
    const openAt = deviceViewerSource.indexOf('terminal.open(host)', initializeAt);
    const snapshotAt = deviceViewerSource.indexOf(
      '() => deviceSessions.terminalScreenSnapshot(ref)',
      initializeAt
    );

    expect(initializeAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeGreaterThan(initializeAt);
    expect(snapshotAt).toBeGreaterThan(initializeAt);
    expect(openAt).toBeLessThan(snapshotAt);
  });

  it('instantly refits and snaps local xterm after either mobile keyboard transition', () => {
    expect(source).not.toContain('if (mobileKeyboardOpen()) return');
    expect(source).toMatch(
      /if \(detail\?\.keyboardOpen \|\| detail\?\.keyboardClosed\) \{[^}]*scheduleTerminalViewportSnap\(fitAndSnapToBottom\)/s
    );
    expect(source).toContain('currentTerm.scrollToBottom();');
    expect(source).toContain('smoothScrollDuration: 0');
    expect(deviceViewerSource).toContain('smoothScrollDuration: 0');
  });

  it('enables momentum swipe scrolling for local and remote xterm sessions', () => {
    expect(source).toContain('attachTerminalTouchScroll({');
    expect(deviceViewerSource).toContain('attachTerminalTouchScroll({');
  });
});
