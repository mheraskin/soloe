import { describe, expect, it } from 'vitest';
import source from './TerminalPane.svelte?raw';
import deviceViewerSource from './DeviceTerminalViewer.svelte?raw';
import surfaceSource from './GhosttyTerminal.svelte?raw';

describe('Ghostty terminal presentation', () => {
  it('uses the shared Ghostty surface for local and Device terminals', () => {
    expect(source).toContain("import GhosttyTerminal from './GhosttyTerminal.svelte'");
    expect(deviceViewerSource).toContain("import GhosttyTerminal from './GhosttyTerminal.svelte'");
    expect(surfaceSource).toContain('GhosttyTerminalSurface.create');
    expect(`${source}\n${deviceViewerSource}\n${surfaceSource}`).not.toContain('@xterm');
  });

  it('renders read-only terminals through the same Ghostty grid', () => {
    expect(source).toContain('interactive={ownsInput}');
    expect(deviceViewerSource).toContain('interactive={ownsInput && pageVisible}');
    expect(`${source}\n${deviceViewerSource}`).not.toContain('TerminalTranscript');
  });

  it('does not renew or release durable Session Control with pane visibility', () => {
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('terminalControl.release(terminalId)');
    expect(source).toContain('connection?.setVisible(nextVisible)');
  });

  it('applies incremental history bytes and resets only when the prefix changes', () => {
    expect(surfaceSource).toContain('terminalState.buffer.startsWith(appliedBuffer)');
    expect(surfaceSource).toContain('current.write(terminalState.buffer.slice(appliedBuffer.length))');
    expect(surfaceSource).toContain('current.resetAndWrite(terminalState.buffer)');
  });
});
