import { describe, expect, it } from 'vitest';
import source from './TerminalPane.svelte?raw';
import deviceViewerSource from './DeviceTerminalViewer.svelte?raw';
import surfaceSource from './GhosttyTerminal.svelte?raw';
import ghosttySurfaceSource from '../lib/ghostty/surface.ts?raw';

describe('Ghostty terminal presentation', () => {
  it('uses the shared Ghostty surface for local and Device terminals', () => {
    expect(source).toContain("import GhosttyTerminal from './GhosttyTerminal.svelte'");
    expect(deviceViewerSource).toContain("import GhosttyTerminal from './GhosttyTerminal.svelte'");
    expect(surfaceSource).toContain('GhosttyTerminalSurface.create');
    expect(`${source}\n${deviceViewerSource}\n${surfaceSource}`).not.toContain('@xterm');
  });

  it('renders read-only terminals through the same Ghostty grid', () => {
    expect(source).toContain('interactive={ownsInput}');
    expect(deviceViewerSource).toContain(
      'interactive={active && interactive && ownsInput && pageVisible && !offline}'
    );
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
    expect(surfaceSource).toContain('current.resetAndReplay(terminalState.buffer, terminalState.replay)');
  });

  it('requests a real PTY resize cycle after restoring a truncated replay tail', () => {
    expect(source).toContain('terminalState.truncated ? terminalState.fromSeq : null');
    expect(deviceViewerSource).toContain(
      'terminalState?.truncated ? terminalState.fromSeq : null'
    );
    expect(source).toContain('terminalPresentationRedrawSizes(dimensions)');
    expect(deviceViewerSource).toContain('terminalPresentationRedrawSizes(dimensions)');
  });

  it('refits Ghostty after the mobile keyboard changes the visible viewport', () => {
    expect(ghosttySurfaceSource).toContain('window.addEventListener("soloe:rail-layout"');
    expect(ghosttySurfaceSource).toMatch(
      /onLayoutChange[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*this\.fit\(\)/
    );
  });

  it('enables momentum swipe scrolling in the shared local and remote Ghostty surface', () => {
    expect(ghosttySurfaceSource).toContain('private startTouchMomentum(');
    expect(ghosttySurfaceSource).toContain('terminalTouchMomentumStep(');
    expect(surfaceSource).toContain('GhosttyTerminalSurface.create');
  });
});
